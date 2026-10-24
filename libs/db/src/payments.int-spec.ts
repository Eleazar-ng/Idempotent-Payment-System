import { processorIdempotencyKey } from '../../payments-core/src';
import type { AttemptStatus, ProcessorOutcome } from '../../payments-core/src';
import {
  advanceAttemptTo,
  createAttemptInStatus,
  createMerchant,
  setAttemptStatus,
  startMigratedPostgres,
  TestPostgres,
  uid,
} from '../../testing/src';
import { attachAttempt, claimKey, completeKey } from './idempotency';
import { applyProcessorOutcome, beginAttempt, findActiveAttempt, getAttempt, getPayment } from './payments';
import type { BeginAttemptInput } from './payments';

describe('payments: beginAttempt and applyProcessorOutcome (real Postgres)', () => {
  let pg: TestPostgres;
  let merchantId: number;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    merchantId = await createMerchant(pg.db);
  });

  afterAll(async () => {
    await pg?.stop();
  });

  const order = (over: Partial<BeginAttemptInput> = {}): BeginAttemptInput => ({
    merchantId,
    orderId: `ord_${uid()}`,
    amount: 5000,
    currency: 'NGN',
    paymentSource: 'tok_visa',
    ...over,
  });

  const countRows = async (table: 'payment_intents' | 'payment_attempts', merchant = merchantId) => {
    const rows =
      table === 'payment_intents'
        ? await pg.db.selectFrom('payment_intents').select('id').where('merchant_id', '=', merchant).execute()
        : await pg.db
            .selectFrom('payment_attempts')
            .innerJoin('payment_intents', 'payment_intents.id', 'payment_attempts.payment_intent_id')
            .select('payment_attempts.id')
            .where('payment_intents.merchant_id', '=', merchant)
            .execute();
    return rows.length;
  };

  describe('beginAttempt', () => {
    it('creates the intent and attempt 1, with the processor key derived and already persisted', async () => {
      const input = order();
      const result = await beginAttempt(pg.db, input);

      expect(result.outcome).toBe('started');
      if (result.outcome !== 'started') return;
      expect(result.intent).toMatchObject({ order_id: input.orderId, amount: 5000, currency: 'NGN', status: 'open' });
      expect(result.attempt).toMatchObject({
        payment_intent_id: result.intent.id,
        attempt_number: 1,
        status: 'created',
        processor_idempotency_key: processorIdempotencyKey(result.intent.id, 1),
        processor_charge_id: null,
      });
      // really in the database, not just returned
      expect((await getAttempt(pg.db, result.attempt.id))!.processor_idempotency_key).toBe(
        `pi_${result.intent.id}_a1`,
      );
    });

    it('links the claimed idempotency key to the attempt in the same transaction', async () => {
      const key = `k-${uid()}`;
      const input = order({ idempotencyKey: key });
      await claimKey(pg.db, { merchantId, key, request: { operation: 'op', body: {} } });

      const result = await beginAttempt(pg.db, input);
      expect(result.outcome).toBe('started');
      const row = await pg.db
        .selectFrom('idempotency_keys')
        .select('attempt_id')
        .where('merchant_id', '=', merchantId)
        .where('idempotency_key', '=', key)
        .executeTakeFirstOrThrow();
      expect(row.attempt_id).toBe(result.outcome === 'started' ? result.attempt.id : -1);
    });

    it('rolls everything back if the key cannot be linked (nothing half-created)', async () => {
      const intentsBefore = await countRows('payment_intents');
      const attemptsBefore = await countRows('payment_attempts');

      await expect(beginAttempt(pg.db, order({ idempotencyKey: `never-claimed-${uid()}` }))).rejects.toThrow(
        /could not be linked/,
      );

      expect(await countRows('payment_intents')).toBe(intentsBefore);
      expect(await countRows('payment_attempts')).toBe(attemptsBefore);
    });

    describe('while another attempt for the order is not finished', () => {
      it.each(['created', 'calling_processor', 'processing', 'requires_action', 'abandoned'] as AttemptStatus[])(
        'a %s attempt blocks a new one, and is reported',
        async (status) => {
          const input = order();
          const first = await beginAttempt(pg.db, input);
          if (first.outcome !== 'started') throw new Error('setup failed');
          await advanceAttemptTo(pg.db, first.attempt.id, status);

          const second = await beginAttempt(pg.db, input);

          expect(second.outcome).toBe('attempt_in_progress');
          if (second.outcome === 'attempt_in_progress') {
            expect(second.activeAttempt.id).toBe(first.attempt.id);
            expect(second.activeAttempt.status).toBe(status);
          }
          expect(await pg.db.selectFrom('payment_attempts').select('id').where('payment_intent_id', '=', first.intent.id).execute()).toHaveLength(1);
        },
      );
    });

    it('after a FAILED attempt a new one is allowed, numbered 2, with its own processor key', async () => {
      const input = order();
      const first = await beginAttempt(pg.db, input);
      if (first.outcome !== 'started') throw new Error('setup failed');
      await advanceAttemptTo(pg.db, first.attempt.id, 'failed');

      const second = await beginAttempt(pg.db, input);

      expect(second.outcome).toBe('started');
      if (second.outcome === 'started') {
        expect(second.intent.id).toBe(first.intent.id);
        expect(second.attempt.attempt_number).toBe(2);
        expect(second.attempt.processor_idempotency_key).toBe(processorIdempotencyKey(first.intent.id, 2));
        expect(second.attempt.processor_idempotency_key).not.toBe(first.attempt.processor_idempotency_key);
      }
    });

    it('an order that is already paid starts nothing and points at the successful attempt', async () => {
      const input = order();
      const first = await beginAttempt(pg.db, input);
      if (first.outcome !== 'started') throw new Error('setup failed');
      await advanceAttemptTo(pg.db, first.attempt.id, 'succeeded');

      const again = await beginAttempt(pg.db, input);

      expect(again.outcome).toBe('already_paid');
      if (again.outcome === 'already_paid') {
        expect(again.intent.status).toBe('succeeded');
        expect(again.attempt?.id).toBe(first.attempt.id);
      }
      expect(await pg.db.selectFrom('payment_attempts').select('id').where('payment_intent_id', '=', first.intent.id).execute()).toHaveLength(1);
    });

    it('a canceled order starts nothing', async () => {
      const input = order();
      const first = await beginAttempt(pg.db, input);
      if (first.outcome !== 'started') throw new Error('setup failed');
      await advanceAttemptTo(pg.db, first.attempt.id, 'failed');
      await pg.db.updateTable('payment_intents').set({ status: 'canceled' }).where('id', '=', first.intent.id).execute();

      expect((await beginAttempt(pg.db, input)).outcome).toBe('order_canceled');
    });

    it.each([
      ['a different amount', { amount: 5001 }],
      ['a different currency', { currency: 'USD' }],
    ])('refuses an existing order requested with %s, and creates no attempt', async (_name, change) => {
      const input = order();
      const first = await beginAttempt(pg.db, input);
      if (first.outcome !== 'started') throw new Error('setup failed');
      await advanceAttemptTo(pg.db, first.attempt.id, 'failed'); // so only the mismatch can block it

      const result = await beginAttempt(pg.db, { ...input, ...change });

      expect(result.outcome).toBe('order_conflict');
      expect(await pg.db.selectFrom('payment_attempts').select('id').where('payment_intent_id', '=', first.intent.id).execute()).toHaveLength(1);
    });

    it('the same order id for two merchants is two independent orders', async () => {
      const other = await createMerchant(pg.db);
      const orderId = `ord_${uid()}`;
      const a = await beginAttempt(pg.db, order({ orderId }));
      const b = await beginAttempt(pg.db, order({ orderId, merchantId: other, amount: 999 }));

      expect(a.outcome).toBe('started');
      expect(b.outcome).toBe('started');
      if (a.outcome === 'started' && b.outcome === 'started') {
        expect(a.intent.id).not.toBe(b.intent.id);
        expect(a.attempt.processor_idempotency_key).not.toBe(b.attempt.processor_idempotency_key);
      }
    });

    describe('concurrency (failure modes 2.4 and 2.7)', () => {
      it('30 simultaneous requests for one order: exactly one starts an attempt, 29 are told one is in progress', async () => {
        const input = order();
        const results = await Promise.all(Array.from({ length: 30 }, () => beginAttempt(pg.db, input)));

        const tally = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
        expect(tally).toEqual({ started: 1, attempt_in_progress: 29 });

        const intent = await pg.db.selectFrom('payment_intents').select('id').where('order_id', '=', input.orderId).execute();
        expect(intent).toHaveLength(1);
        const attempts = await pg.db.selectFrom('payment_attempts').select('id').where('payment_intent_id', '=', intent[0].id).execute();
        expect(attempts).toHaveLength(1);

        const winner = results.find((r) => r.outcome === 'started');
        for (const r of results) {
          if (r.outcome === 'attempt_in_progress') expect(r.activeAttempt.id).toBe((winner as { attempt: { id: number } }).attempt.id);
        }
      });

      it('racing orders that are different never block each other', async () => {
        const results = await Promise.all(Array.from({ length: 20 }, () => beginAttempt(pg.db, order())));
        expect(results.every((r) => r.outcome === 'started')).toBe(true);
      });
    });
  });

  describe('getPayment and findActiveAttempt', () => {
    it('returns the intent with its latest attempt', async () => {
      const first = await beginAttempt(pg.db, order());
      if (first.outcome !== 'started') throw new Error('setup failed');
      await advanceAttemptTo(pg.db, first.attempt.id, 'failed');
      const second = await beginAttempt(pg.db, order({ orderId: first.intent.order_id }));
      if (second.outcome !== 'started') throw new Error('setup failed');

      const record = await getPayment(pg.db, merchantId, first.intent.id);
      expect(record?.latestAttempt?.attempt_number).toBe(2);
      expect((await findActiveAttempt(pg.db, first.intent.id))?.id).toBe(second.attempt.id);
    });

    it('never shows one merchant another merchant’s payment', async () => {
      const other = await createMerchant(pg.db);
      const result = await beginAttempt(pg.db, order());
      if (result.outcome !== 'started') throw new Error('setup failed');
      expect(await getPayment(pg.db, other, result.intent.id)).toBeUndefined();
      expect(await getPayment(pg.db, merchantId, 987654321)).toBeUndefined();
    });

    it('has no latest attempt for an intent that has none', async () => {
      const intent = await pg.db
        .insertInto('payment_intents')
        .values({ merchant_id: merchantId, order_id: `ord_${uid()}`, amount: 1, currency: 'NGN' })
        .returning('id')
        .executeTakeFirstOrThrow();
      expect((await getPayment(pg.db, merchantId, intent.id))?.latestAttempt).toBeUndefined();
      expect(await findActiveAttempt(pg.db, intent.id)).toBeUndefined();
    });
  });

  describe('attachAttempt', () => {
    async function claimed() {
      const key = `k-${uid()}`;
      await claimKey(pg.db, { merchantId, key, request: { operation: 'op', body: {} } });
      const { attemptId } = await createAttemptInStatus(pg.db, 'created', merchantId);
      const { attemptId: otherAttemptId } = await createAttemptInStatus(pg.db, 'created', merchantId);
      return { key, attemptId, otherAttemptId };
    }

    it('links once, repeats harmlessly, and refuses a different attempt', async () => {
      const { key, attemptId, otherAttemptId } = await claimed();
      expect(await attachAttempt(pg.db, merchantId, key, attemptId)).toBe(true);
      expect(await attachAttempt(pg.db, merchantId, key, attemptId)).toBe(true);
      expect(await attachAttempt(pg.db, merchantId, key, otherAttemptId)).toBe(false);
    });

    it('refuses a key that is already completed, or that does not exist', async () => {
      const { key, attemptId } = await claimed();
      await completeKey(pg.db, { merchantId, key, response: { status: 201 } });
      expect(await attachAttempt(pg.db, merchantId, key, attemptId)).toBe(false);
      expect(await attachAttempt(pg.db, merchantId, `never-${uid()}`, attemptId)).toBe(false);
    });
  });

  describe('applyProcessorOutcome', () => {
    const fresh = async () => {
      const { attemptId, intentId } = await createAttemptInStatus(pg.db, 'calling_processor', merchantId);
      return { attemptId, intentId };
    };
    const intentStatus = async (id: number) =>
      (await pg.db.selectFrom('payment_intents').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;

    it('succeeded: the attempt succeeds with its charge id, and the database marks the intent succeeded', async () => {
      const { attemptId, intentId } = await fresh();
      const result = await applyProcessorOutcome(pg.db, attemptId, { kind: 'succeeded', chargeId: 'ch_1' }, 'calling_processor');

      expect(result).toMatchObject({ outcome: 'applied', attempt: { status: 'succeeded', processor_charge_id: 'ch_1' } });
      expect(await intentStatus(intentId)).toBe('succeeded');
    });

    it.each([
      ['requires_action', 'requires_action'],
      ['processing', 'processing'],
    ] as const)('%s: the attempt moves to %s and keeps the charge id for reconciliation', async (kind, status) => {
      const { attemptId, intentId } = await fresh();
      const chargeId = `ch_${uid()}`;
      const outcome = { kind, chargeId } as ProcessorOutcome;
      const result = await applyProcessorOutcome(pg.db, attemptId, outcome, 'calling_processor');

      expect(result).toMatchObject({ outcome: 'applied', attempt: { status, processor_charge_id: chargeId } });
      expect(await intentStatus(intentId)).toBe('open');
    });

    it('declined: the attempt fails with the processor’s code, the intent stays open for another try', async () => {
      const { attemptId, intentId } = await fresh();
      const result = await applyProcessorOutcome(pg.db, attemptId, { kind: 'declined', code: 'insufficient_funds', chargeId: 'ch_3' }, 'calling_processor');

      expect(result).toMatchObject({
        outcome: 'applied',
        attempt: { status: 'failed', failure_reason: 'insufficient_funds', processor_charge_id: 'ch_3' },
      });
      expect(await intentStatus(intentId)).toBe('open');
    });

    it('declined without a charge id is fine', async () => {
      const { attemptId } = await fresh();
      const result = await applyProcessorOutcome(pg.db, attemptId, { kind: 'declined', code: 'card_declined' }, 'calling_processor');
      expect(result).toMatchObject({ outcome: 'applied', attempt: { status: 'failed', processor_charge_id: null } });
    });

    it('rejected: fails with a reason that says it was our request that was refused', async () => {
      const { attemptId } = await fresh();
      const result = await applyProcessorOutcome(pg.db, attemptId, { kind: 'rejected', code: 'parameter_invalid' }, 'calling_processor');
      expect(result).toMatchObject({ outcome: 'applied', attempt: { status: 'failed', failure_reason: 'processor_rejected:parameter_invalid' } });
    });

    it('unknown: changes nothing at all (not knowing is not a reason to fail the attempt)', async () => {
      const { attemptId } = await fresh();
      const before = await getAttempt(pg.db, attemptId);
      const result = await applyProcessorOutcome(pg.db, attemptId, { kind: 'unknown', reason: 'timeout' }, 'calling_processor');

      expect(result).toEqual({ outcome: 'no_change' });
      expect(await getAttempt(pg.db, attemptId)).toEqual(before);
    });

    it('applying the same outcome twice is harmless: the second is already_applied', async () => {
      const { attemptId } = await fresh();
      const outcome: ProcessorOutcome = { kind: 'succeeded', chargeId: 'ch_4' };
      expect((await applyProcessorOutcome(pg.db, attemptId, outcome, 'calling_processor')).outcome).toBe('applied');
      expect((await applyProcessorOutcome(pg.db, attemptId, outcome, 'calling_processor')).outcome).toBe('already_applied');
    });

    it('a late conflicting outcome is stale and cannot undo the truth', async () => {
      const { attemptId, intentId } = await fresh();
      await applyProcessorOutcome(pg.db, attemptId, { kind: 'succeeded', chargeId: 'ch_5' }, 'calling_processor');

      const late = await applyProcessorOutcome(pg.db, attemptId, { kind: 'declined', code: 'card_declined' }, 'calling_processor');

      expect(late.outcome).toBe('stale');
      expect((await getAttempt(pg.db, attemptId))!.status).toBe('succeeded');
      expect(await intentStatus(intentId)).toBe('succeeded');
    });

    it('a webhook-style move to failed that happened first makes a later success stale', async () => {
      const { attemptId } = await fresh();
      await setAttemptStatus(pg.db, attemptId, 'failed');
      const result = await applyProcessorOutcome(pg.db, attemptId, { kind: 'succeeded', chargeId: 'ch_6' }, 'calling_processor');
      expect(result.outcome).toBe('stale');
    });

    it('works inside a transaction and rolls back with it', async () => {
      const { attemptId } = await fresh();
      await expect(
        pg.db.transaction().execute(async (trx) => {
          await applyProcessorOutcome(trx, attemptId, { kind: 'succeeded', chargeId: 'ch_7' }, 'calling_processor');
          throw new Error('later step failed');
        }),
      ).rejects.toThrow('later step failed');
      expect((await getAttempt(pg.db, attemptId))!.status).toBe('calling_processor');
    });
  });
});

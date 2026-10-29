import type { ProcessorOutcome } from '../../payments-core/src';
import { createAttemptInStatus, createLedgerAccount, createMerchant, startMigratedPostgres, TestPostgres, uid } from '../../testing/src';
import {
  claimDueOutboxEvents,
  enqueuePaymentEvent,
  findAttemptsMissingOutboxEvent,
  listDeadOutboxEvents,
  markOutboxDead,
  markOutboxDelivered,
  markOutboxSkipped,
  requeueDeadOutboxEvent,
  scheduleOutboxRetry,
} from './outbox';
import { LedgerAccountMismatchError } from './ledger';
import { applyProcessorOutcome } from './payments';

describe('outbox (real Postgres)', () => {
  let pg: TestPostgres;
  const t0 = new Date('2026-10-28T10:00:00Z');
  const later = (ms: number) => new Date(t0.getTime() + ms);

  beforeAll(async () => {
    pg = await startMigratedPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    await pg.db.deleteFrom('outbox_events').execute(); // DELETE is allowed on purpose: retention
  });

  const apply = (attemptId: number, outcome: ProcessorOutcome, from: 'calling_processor' | 'processing' = 'calling_processor') =>
    applyProcessorOutcome(pg.db, attemptId, outcome, from, { feeBps: 150 });
  const eventsFor = (attemptId: number) =>
    pg.db.selectFrom('outbox_events').selectAll().where('dedupe_key', 'like', `%:attempt:${attemptId}`).execute();

  async function rawEvent(merchantId: number, over: Record<string, unknown> = {}) {
    return pg.db
      .insertInto('outbox_events')
      .values({
        dedupe_key: `k_${uid()}`,
        merchant_id: merchantId,
        event_type: 'payment.succeeded',
        payload: JSON.stringify({ n: 1 }),
        next_attempt_at: t0,
        ...over,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  }
  const row = (id: number) => pg.db.selectFrom('outbox_events').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  describe('writing events with the change that causes them', () => {
    it('a success queues one payment.succeeded event with the facts from the database', async () => {
      const { attemptId, intentId, merchantId } = await createAttemptInStatus(pg.db, 'calling_processor');
      await apply(attemptId, { kind: 'succeeded', chargeId: `ch_${uid()}` });

      const [event] = await eventsFor(attemptId);
      expect(event).toMatchObject({ merchant_id: merchantId, event_type: 'payment.succeeded', status: 'pending', attempts: 0 });
      expect(event.payload).toMatchObject({
        payment_id: `pay_${intentId}`,
        amount: 5000,
        currency: 'NGN',
        attempt_id: attemptId,
        attempt_number: 1,
        failure_code: null,
      });
    });

    it('the same success applied again (webhook after API) still leaves exactly one event', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      const outcome = { kind: 'succeeded', chargeId: `ch_${uid()}` } as const;
      await apply(attemptId, outcome);
      await apply(attemptId, outcome, 'processing');
      expect(await eventsFor(attemptId)).toHaveLength(1);
    });

    it('a decline queues payment.failed with the reason', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      await apply(attemptId, { kind: 'declined', code: 'insufficient_funds' });
      const [event] = await eventsFor(attemptId);
      expect(event.event_type).toBe('payment.failed');
      expect(event.payload).toMatchObject({ failure_code: 'insufficient_funds' });
    });

    it('a rejection queues payment.failed with the rejection reason', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      await apply(attemptId, { kind: 'rejected', code: 'invalid_request' });
      expect((await eventsFor(attemptId))[0].payload).toMatchObject({ failure_code: 'processor_rejected:invalid_request' });
    });

    it.each<[string, ProcessorOutcome]>([
      ['requires_action', { kind: 'requires_action', chargeId: 'ch_ra' }],
      ['processing', { kind: 'processing', chargeId: 'ch_pr' }],
      ['unknown', { kind: 'unknown', reason: 'timeout' }],
    ])('%s is not news for the merchant yet: nothing queued', async (_n, outcome) => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      await apply(attemptId, outcome.kind === 'unknown' ? outcome : { ...outcome, chargeId: `ch_${uid()}` } as ProcessorOutcome);
      expect(await eventsFor(attemptId)).toHaveLength(0);
    });

    it('a stale outcome (attempt already failed) queues nothing for the success it was not', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      await apply(attemptId, { kind: 'declined', code: 'card_declined' });
      await apply(attemptId, { kind: 'succeeded', chargeId: `ch_${uid()}` });
      const types = (await eventsFor(attemptId)).map((e) => e.event_type);
      expect(types).toEqual(['payment.failed']);
    });

    it('is rolled back with the transaction: if booking fails there is no event and no status change', async () => {
      const { attemptId, merchantId } = await createAttemptInStatus(pg.db, 'calling_processor');
      await createLedgerAccount(pg.db, 'expense', 'NGN', `merchant_payable:${merchantId}:NGN`);
      await expect(apply(attemptId, { kind: 'succeeded', chargeId: `ch_${uid()}` })).rejects.toBeInstanceOf(
        LedgerAccountMismatchError,
      );
      expect(await eventsFor(attemptId)).toHaveLength(0);
    });

    it('is repaired when the same outcome arrives again and the event is missing', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      const outcome = { kind: 'succeeded', chargeId: `ch_${uid()}` } as const;
      await apply(attemptId, outcome);
      await pg.db.deleteFrom('outbox_events').execute();
      expect(await findAttemptsMissingOutboxEvent(pg.db)).toContainEqual({ attempt_id: attemptId, status: 'succeeded' });

      await apply(attemptId, outcome, 'processing');
      expect(await eventsFor(attemptId)).toHaveLength(1);
      expect((await findAttemptsMissingOutboxEvent(pg.db)).map((m) => m.attempt_id)).not.toContain(attemptId);
    });

    it('enqueuePaymentEvent ignores attempts that are not final and refuses unknown ones', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'processing');
      expect(await enqueuePaymentEvent(pg.db, attemptId)).toBeUndefined();
      await expect(enqueuePaymentEvent(pg.db, 987_654_321)).rejects.toThrow(/no attempt/);
    });
  });

  describe('claiming work', () => {
    it('hands out due events with the merchant endpoint, oldest first, and counts the attempt', async () => {
      const merchantId = await createMerchant(pg.db);
      await pg.db.updateTable('merchants').set({ webhook_url: 'https://m.example/hook', webhook_secret: 'secret-secret-1234' }).where('id', '=', merchantId).execute();
      const a = await rawEvent(merchantId, { next_attempt_at: later(-2000) });
      const b = await rawEvent(merchantId, { next_attempt_at: later(-1000) });

      const claimed = await claimDueOutboxEvents(pg.db, { now: t0, limit: 10, leaseMs: 60_000 });
      expect(claimed.map((e) => e.id)).toEqual([a.id, b.id]);
      expect(claimed[0]).toMatchObject({ attempts: 1, merchant_webhook_url: 'https://m.example/hook', merchant_webhook_secret: 'secret-secret-1234' });
      expect((await row(a.id)).locked_until).toEqual(later(60_000));
    });

    it('does not hand out events that are not due yet, or that are not pending', async () => {
      const merchantId = await createMerchant(pg.db);
      await rawEvent(merchantId, { next_attempt_at: later(1000) });
      const done = await rawEvent(merchantId);
      await markOutboxDelivered(pg.db, done.id, t0);
      expect(await claimDueOutboxEvents(pg.db, { now: t0, limit: 10, leaseMs: 1000 })).toEqual([]);
    });

    it('respects the limit', async () => {
      const merchantId = await createMerchant(pg.db);
      for (let i = 0; i < 5; i++) await rawEvent(merchantId);
      expect(await claimDueOutboxEvents(pg.db, { now: t0, limit: 2, leaseMs: 1000 })).toHaveLength(2);
    });

    it('holds a claim for the lease, then gives the event to someone else (a crashed worker)', async () => {
      const merchantId = await createMerchant(pg.db);
      const { id } = await rawEvent(merchantId);
      expect(await claimDueOutboxEvents(pg.db, { now: t0, limit: 10, leaseMs: 60_000 })).toHaveLength(1);
      expect(await claimDueOutboxEvents(pg.db, { now: later(30_000), limit: 10, leaseMs: 60_000 })).toHaveLength(0);
      const again = await claimDueOutboxEvents(pg.db, { now: later(61_000), limit: 10, leaseMs: 60_000 });
      expect(again.map((e) => e.id)).toEqual([id]);
      expect(again[0].attempts).toBe(2); // the dead worker's try still counted
    });

    it('skips events another transaction is holding instead of waiting for them', async () => {
      const merchantId = await createMerchant(pg.db);
      const locked = await rawEvent(merchantId);
      const free1 = await rawEvent(merchantId);
      const free2 = await rawEvent(merchantId);

      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let lockTaken!: () => void;
      const taken = new Promise<void>((resolve) => (lockTaken = resolve));
      const holder = pg.db.transaction().execute(async (trx) => {
        await trx.selectFrom('outbox_events').select('id').where('id', '=', locked.id).forUpdate().execute();
        lockTaken();
        await held;
      });
      await taken;

      try {
        const timeout = new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 2000));
        const result = await Promise.race([claimDueOutboxEvents(pg.db, { now: t0, limit: 10, leaseMs: 1000 }), timeout]);
        expect(result).not.toBe('blocked');
        expect((result as { id: number }[]).map((e) => e.id).sort()).toEqual([free1.id, free2.id].sort());
      } finally {
        release();
        await holder;
      }
    });

    it('never gives one event to two workers at once', async () => {
      const merchantId = await createMerchant(pg.db);
      for (let i = 0; i < 30; i++) await rawEvent(merchantId);
      const batches = await Promise.all(
        Array.from({ length: 6 }, () => claimDueOutboxEvents(pg.db, { now: t0, limit: 10, leaseMs: 60_000 })),
      );
      const ids = batches.flat().map((e) => e.id);
      expect(ids).toHaveLength(30);
      expect(new Set(ids).size).toBe(30);
    });
  });

  describe('recording what happened', () => {
    async function claimed() {
      const merchantId = await createMerchant(pg.db);
      const { id } = await rawEvent(merchantId);
      const [event] = await claimDueOutboxEvents(pg.db, { now: t0, limit: 1, leaseMs: 60_000 });
      return { id, event };
    }

    it('delivered clears the lease and the error', async () => {
      const { id } = await claimed();
      expect(await markOutboxDelivered(pg.db, id, later(5))).toBe(true);
      expect(await row(id)).toMatchObject({ status: 'delivered', locked_until: null, delivered_at: later(5) });
    });

    it('delivered cannot be marked twice', async () => {
      const { id } = await claimed();
      await markOutboxDelivered(pg.db, id, t0);
      expect(await markOutboxDelivered(pg.db, id, t0)).toBe(false);
    });

    it('skipped is final and keeps the reason', async () => {
      const { id } = await claimed();
      expect(await markOutboxSkipped(pg.db, id, 'no_webhook_url')).toBe(true);
      expect(await row(id)).toMatchObject({ status: 'skipped', last_error: 'no_webhook_url' });
    });

    it('a retry sets the next time and releases the lease', async () => {
      const { id, event } = await claimed();
      expect(await scheduleOutboxRetry(pg.db, id, event.attempts, later(9000), 'http_503')).toBe(true);
      expect(await row(id)).toMatchObject({ status: 'pending', next_attempt_at: later(9000), locked_until: null, last_error: 'http_503' });
    });

    it('a stale worker cannot overwrite a newer claim (fencing)', async () => {
      const { id, event } = await claimed(); // attempts = 1
      const second = await claimDueOutboxEvents(pg.db, { now: later(61_000), limit: 1, leaseMs: 60_000 }); // attempts = 2
      expect(second[0].id).toBe(id);
      expect(await scheduleOutboxRetry(pg.db, id, event.attempts, later(99_999), 'late report')).toBe(false);
      expect(await markOutboxDead(pg.db, id, event.attempts, 'late report')).toBe(false);
      expect((await row(id)).status).toBe('pending');
    });

    it('a stale worker CAN still record success: success always wins', async () => {
      const { id } = await claimed();
      await claimDueOutboxEvents(pg.db, { now: later(61_000), limit: 1, leaseMs: 60_000 });
      expect(await markOutboxDelivered(pg.db, id, later(62_000))).toBe(true);
    });

    it('dead keeps the reason, is listed, and can be requeued from zero', async () => {
      const { id, event } = await claimed();
      expect(await markOutboxDead(pg.db, id, event.attempts, 'http_500')).toBe(true);
      expect((await listDeadOutboxEvents(pg.db)).map((e) => e.id)).toEqual([id]);

      expect(await requeueDeadOutboxEvent(pg.db, id, later(100))).toBe(true);
      expect(await row(id)).toMatchObject({ status: 'pending', attempts: 0, next_attempt_at: later(100) });
      expect(await listDeadOutboxEvents(pg.db)).toEqual([]);
    });

    it('only dead events can be requeued', async () => {
      const { id } = await claimed();
      expect(await requeueDeadOutboxEvent(pg.db, id, t0)).toBe(false);
    });
  });
});

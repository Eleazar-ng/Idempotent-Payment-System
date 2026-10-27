import { parseWebhookEvent } from '../../payments-core/src';
import { createAttemptInStatus, createLedgerAccount, startMigratedPostgres, TestPostgres, uid } from '../../testing/src';
import { checkLedgerInvariants } from './invariants';
import { LedgerAccountMismatchError } from './ledger';
import { applyProcessorOutcome } from './payments';
import { handleWebhookEvent, listWebhookEventsNeedingAttention } from './webhooks';

describe('handleWebhookEvent (real Postgres)', () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  afterEach(async () => {
    expect(await checkLedgerInvariants(pg.db)).toEqual([]);
  });

  async function arrange(status: 'calling_processor' | 'processing' | 'requires_action' | 'abandoned' = 'calling_processor') {
    const seeded = await createAttemptInStatus(pg.db, status);
    const attempt = await pg.db
      .selectFrom('payment_attempts')
      .select(['processor_idempotency_key'])
      .where('id', '=', seeded.attemptId)
      .executeTakeFirstOrThrow();
    return { ...seeded, reference: attempt.processor_idempotency_key, chargeId: `ch_${uid()}` };
  }

  function deliver(
    type: 'charge.succeeded' | 'charge.failed',
    charge: { chargeId: string; reference?: string; amount?: number; currency?: string; failureCode?: string },
    eventId = `evt_${uid()}`,
  ) {
    const raw = JSON.stringify({
      id: eventId,
      object: 'event',
      type,
      created: 1,
      data: {
        object: {
          id: charge.chargeId,
          object: 'charge',
          amount: charge.amount ?? 5000,
          currency: charge.currency ?? 'NGN',
          status: type === 'charge.succeeded' ? 'succeeded' : 'failed',
          failure_code: charge.failureCode ?? null,
          metadata: charge.reference ? { reference: charge.reference } : {},
        },
      },
    });
    const { event, payload } = parseWebhookEvent(raw);
    return { eventId, send: () => handleWebhookEvent(pg.db, { source: 'processor', event, payload, feeBps: 150 }) };
  }

  const attemptRow = (id: number) =>
    pg.db.selectFrom('payment_attempts').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const postings = async (attemptId: number) =>
    (await pg.db.selectFrom('ledger_transactions').select('id').where('posting_key', '=', `attempt:${attemptId}:succeeded`).execute())
      .length;
  const eventRows = (eventId: string) =>
    pg.db.selectFrom('webhook_events').selectAll().where('event_id', '=', eventId).execute();

  describe('charge.succeeded', () => {
    it('moves the attempt to succeeded, books the ledger and records the event', async () => {
      const a = await arrange();
      const d = deliver('charge.succeeded', a);
      const r = await d.send();

      expect(r).toMatchObject({ duplicate: false, result: 'applied', attemptId: a.attemptId });
      expect(await attemptRow(a.attemptId)).toMatchObject({ status: 'succeeded', processor_charge_id: a.chargeId });
      expect(await postings(a.attemptId)).toBe(1);
      const [row] = await eventRows(d.eventId);
      expect(row).toMatchObject({ result: 'applied', attempt_id: a.attemptId, event_type: 'charge.succeeded' });
      expect(row.processed_at).not.toBeNull();
    });

    it('does nothing the second time the same event arrives', async () => {
      const a = await arrange();
      const d = deliver('charge.succeeded', a);
      await d.send();
      const again = await d.send();

      expect(again).toEqual({ duplicate: true, result: 'applied' });
      expect(await postings(a.attemptId)).toBe(1);
      expect(await eventRows(d.eventId)).toHaveLength(1);
    });

    it('handles the same event arriving many times at once exactly once', async () => {
      const a = await arrange();
      const d = deliver('charge.succeeded', a);
      const results = await Promise.all(Array.from({ length: 8 }, () => d.send()));

      expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(results.filter((r) => r.duplicate)).toHaveLength(7);
      expect(await postings(a.attemptId)).toBe(1);
      expect(await eventRows(d.eventId)).toHaveLength(1);
    });

    it('handles two DIFFERENT events for the same charge once (the second finds it done)', async () => {
      const a = await arrange();
      const [first, second] = await Promise.all([
        deliver('charge.succeeded', a).send(),
        deliver('charge.succeeded', a).send(),
      ]);
      expect([first.result, second.result].sort()).toEqual(['already_applied', 'applied']);
      expect(await postings(a.attemptId)).toBe(1);
    });

    it('reports already_applied when the API response got there first, and still books exactly once', async () => {
      const a = await arrange();
      await applyProcessorOutcome(pg.db, a.attemptId, { kind: 'succeeded', chargeId: a.chargeId }, 'calling_processor', { feeBps: 150 });

      const r = await deliver('charge.succeeded', a).send();
      expect(r).toMatchObject({ duplicate: false, result: 'already_applied' });
      expect(await postings(a.attemptId)).toBe(1);
    });

    it('finds the attempt by reference before we know the charge id', async () => {
      const a = await arrange();
      expect((await attemptRow(a.attemptId)).processor_charge_id).toBeNull();
      expect(await deliver('charge.succeeded', a).send()).toMatchObject({ result: 'applied' });
    });

    it('finds the attempt by charge id when the event carries no reference', async () => {
      const a = await arrange('processing');
      await pg.db.updateTable('payment_attempts').set({ processor_charge_id: a.chargeId }).where('id', '=', a.attemptId).execute();
      const r = await deliver('charge.succeeded', { chargeId: a.chargeId }).send();
      expect(r).toMatchObject({ result: 'applied', attemptId: a.attemptId });
    });

    it.each(['processing', 'abandoned', 'requires_action'] as const)('applies to an attempt that is %s', async (status) => {
      const a = await arrange(status);
      expect(await deliver('charge.succeeded', a).send()).toMatchObject({ result: 'applied' });
      expect(await attemptRow(a.attemptId)).toMatchObject({ status: 'succeeded' });
      expect(await postings(a.attemptId)).toBe(1);
    });
  });

  describe('charge.failed', () => {
    it.each(['calling_processor', 'processing', 'requires_action', 'abandoned'] as const)(
      'fails an attempt that is %s, with the reason, and books nothing',
      async (status) => {
        const a = await arrange(status);
        const r = await deliver('charge.failed', { ...a, failureCode: 'insufficient_funds' }).send();
        expect(r).toMatchObject({ result: 'applied' });
        expect(await attemptRow(a.attemptId)).toMatchObject({
          status: 'failed',
          failure_reason: 'insufficient_funds',
          processor_charge_id: a.chargeId,
        });
        expect(await postings(a.attemptId)).toBe(0);
      },
    );

    it('defaults the reason to card_declined', async () => {
      const a = await arrange();
      await deliver('charge.failed', a).send();
      expect(await attemptRow(a.attemptId)).toMatchObject({ failure_reason: 'card_declined' });
    });

    it('is already_applied when the attempt had already failed', async () => {
      const a = await arrange();
      await deliver('charge.failed', a).send();
      expect(await deliver('charge.failed', a).send()).toMatchObject({ duplicate: false, result: 'already_applied' });
    });
  });

  describe('events that disagree with what we hold are recorded, never forced', () => {
    it('a success for an attempt that already failed is a conflict, and money state is untouched', async () => {
      const a = await arrange();
      await deliver('charge.failed', a).send();
      const r = await deliver('charge.succeeded', a).send();

      expect(r).toMatchObject({ result: 'conflict', detail: expect.stringContaining('attempt is failed') });
      expect(await attemptRow(a.attemptId)).toMatchObject({ status: 'failed' });
      expect(await postings(a.attemptId)).toBe(0);
    });

    it('a failure for an attempt that already succeeded is a conflict', async () => {
      const a = await arrange();
      await deliver('charge.succeeded', a).send();
      const r = await deliver('charge.failed', a).send();

      expect(r).toMatchObject({ result: 'conflict' });
      expect(await attemptRow(a.attemptId)).toMatchObject({ status: 'succeeded' });
      expect(await postings(a.attemptId)).toBe(1);
    });

    it('a different amount is a mismatch and is not applied', async () => {
      const a = await arrange();
      const r = await deliver('charge.succeeded', { ...a, amount: 4999 }).send();
      expect(r).toMatchObject({ result: 'mismatch' });
      expect(await attemptRow(a.attemptId)).toMatchObject({ status: 'calling_processor' });
    });

    it('a different currency is a mismatch and is not applied', async () => {
      const a = await arrange();
      expect(await deliver('charge.succeeded', { ...a, currency: 'GHS' }).send()).toMatchObject({ result: 'mismatch' });
      expect(await attemptRow(a.attemptId)).toMatchObject({ status: 'calling_processor' });
    });

    it('a charge id that differs from the one the attempt is bound to is a conflict', async () => {
      const a = await arrange('processing');
      await pg.db.updateTable('payment_attempts').set({ processor_charge_id: `ch_${uid()}` }).where('id', '=', a.attemptId).execute();
      const r = await deliver('charge.succeeded', { chargeId: `ch_${uid()}`, reference: a.reference }).send();
      expect(r).toMatchObject({ result: 'conflict' });
      expect(await attemptRow(a.attemptId)).toMatchObject({ status: 'processing' });
    });

    it('a charge that no attempt explains is unmatched', async () => {
      const r = await deliver('charge.succeeded', { chargeId: `ch_${uid()}`, reference: `pi_nobody_${uid()}` }).send();
      expect(r).toMatchObject({ result: 'unmatched', attemptId: null });
    });

    it('lists everything that needs attention, and only that', async () => {
      const a = await arrange();
      const ok = deliver('charge.succeeded', a);
      await ok.send();
      const bad = deliver('charge.succeeded', { chargeId: `ch_${uid()}`, reference: 'pi_none' });
      await bad.send();

      const ids = (await listWebhookEventsNeedingAttention(pg.db)).map((e) => e.event_id);
      expect(ids).toContain(bad.eventId);
      expect(ids).not.toContain(ok.eventId);
    });
  });

  it('acknowledges event types it has no handler for, once', async () => {
    const raw = JSON.stringify({ id: `evt_${uid()}`, type: 'payout.paid', data: { object: {} } });
    const { event, payload } = parseWebhookEvent(raw);
    const send = () => handleWebhookEvent(pg.db, { source: 'processor', event, payload, feeBps: 150 });
    expect(await send()).toMatchObject({ duplicate: false, result: 'ignored' });
    expect(await send()).toEqual({ duplicate: true, result: 'ignored' });
  });

  it('the same event id from a different source is a different event', async () => {
    const a = await arrange();
    const d = deliver('charge.succeeded', a);
    await d.send();
    const raw = JSON.stringify({ id: d.eventId, type: 'payout.paid', data: { object: {} } });
    const { event, payload } = parseWebhookEvent(raw);
    const other = await handleWebhookEvent(pg.db, { source: 'other_processor', event, payload, feeBps: 0 });
    expect(other).toMatchObject({ duplicate: false, result: 'ignored' });
  });

  describe('when handling fails, nothing is half done and the event is not marked as seen', () => {
    it('rolls the claim, the status change and the posting back together', async () => {
      const a = await arrange();
      // Booking will fail: the payable account already exists as the wrong kind.
      await createLedgerAccount(pg.db, 'expense', 'NGN', `merchant_payable:${a.merchantId}:NGN`);
      const d = deliver('charge.succeeded', a);

      await expect(d.send()).rejects.toBeInstanceOf(LedgerAccountMismatchError);
      expect(await eventRows(d.eventId)).toHaveLength(0);
      expect(await attemptRow(a.attemptId)).toMatchObject({ status: 'calling_processor', processor_charge_id: null });
      expect(await postings(a.attemptId)).toBe(0);

    });
  });
});

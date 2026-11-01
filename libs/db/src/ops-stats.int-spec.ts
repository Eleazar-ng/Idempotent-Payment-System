import { createAttemptInStatus, createMerchant, startMigratedPostgres, TestPostgres, uid } from '../../testing/src';
import { enqueuePaymentEvent } from './outbox';
import { collectOperationalStats } from './ops-stats';
import { recordFinding, resolveFinding } from './recovery';

describe('operational stats (real Postgres)', () => {
  let pg: TestPostgres;
  const after = (ms: number) => new Date(Date.now() + ms);

  beforeAll(async () => {
    pg = await startMigratedPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  it('on an empty database every status is present and zero, so a gauge never disappears', async () => {
    const stats = await collectOperationalStats(pg.db, new Date());
    expect(stats.outboxByStatus).toEqual({ pending: 0, delivered: 0, skipped: 0, dead: 0 });
    expect(stats.attemptsByStatus).toEqual({ created: 0, calling_processor: 0, processing: 0, requires_action: 0, abandoned: 0 });
    expect(stats.attemptsOldestIdleSeconds.calling_processor).toBe(0);
    expect(stats.outboxOldestDueSeconds).toBe(0);
    expect(stats.openFindingsByKind).toEqual({});
    expect(stats.attemptsMissingOutboxEvent).toBe(0);
    expect(stats.ledgerViolations).toBe(0);
  });

  it('counts only attempts that are not final, with the idle time of the oldest in each status', async () => {
    const merchantId = await createMerchant(pg.db);
    await createAttemptInStatus(pg.db, 'calling_processor', merchantId);
    await createAttemptInStatus(pg.db, 'calling_processor', merchantId);
    await createAttemptInStatus(pg.db, 'processing', merchantId);
    await createAttemptInStatus(pg.db, 'succeeded', merchantId);
    await createAttemptInStatus(pg.db, 'failed', merchantId);

    const stats = await collectOperationalStats(pg.db, after(10 * 60_000));

    expect(stats.attemptsByStatus).toMatchObject({ calling_processor: 2, processing: 1, requires_action: 0, abandoned: 0 });
    // ten minutes after they were written, give or take the time the test itself took
    expect(stats.attemptsOldestIdleSeconds.calling_processor).toBeGreaterThan(590);
    expect(stats.attemptsOldestIdleSeconds.calling_processor).toBeLessThan(620);
    expect(stats.attemptsOldestIdleSeconds.requires_action).toBe(0);
  });

  it('measures outbox backlog by what is DUE: an event scheduled for later is not lag', async () => {
    // Earlier tests left due events behind; schedule them for tomorrow so only this test's event can be lag.
    await pg.db.updateTable('outbox_events').set({ next_attempt_at: after(24 * 60 * 60_000) }).where('status', '=', 'pending').execute();
    const merchantId = await createMerchant(pg.db);
    const { attemptId } = await createAttemptInStatus(pg.db, 'succeeded', merchantId);
    const event = await pg.db.selectFrom('outbox_events').select('id').where('dedupe_key', '=', `payment.succeeded:attempt:${attemptId}`).executeTakeFirstOrThrow();

    const now = after(5 * 60_000);
    expect((await collectOperationalStats(pg.db, now)).outboxOldestDueSeconds).toBeGreaterThan(290);

    await pg.db.updateTable('outbox_events').set({ next_attempt_at: after(60 * 60_000) }).where('id', '=', event.id).execute();
    const later = await collectOperationalStats(pg.db, now);
    expect(later.outboxByStatus.pending).toBeGreaterThanOrEqual(1);
    expect(later.outboxOldestDueSeconds).toBe(0);
  });

  it('counts open findings by kind and not resolved ones', async () => {
    const now = new Date();
    const a = await recordFinding(pg.db, { kind: 'orphan_charge', source: 'reconciliation', dedupeKey: `o:${uid()}`, chargeId: `ch_${uid()}`, detail: 'x', now });
    await recordFinding(pg.db, { kind: 'orphan_charge', source: 'reconciliation', dedupeKey: `o:${uid()}`, chargeId: `ch_${uid()}`, detail: 'x', now });
    await recordFinding(pg.db, { kind: 'amount_mismatch', source: 'recovery', dedupeKey: `m:${uid()}`, chargeId: `ch_${uid()}`, detail: 'x', now });

    expect((await collectOperationalStats(pg.db, now)).openFindingsByKind).toEqual({ orphan_charge: 2, amount_mismatch: 1 });

    await resolveFinding(pg.db, a.id, 'refunded by hand', now);
    expect((await collectOperationalStats(pg.db, now)).openFindingsByKind).toEqual({ orphan_charge: 1, amount_mismatch: 1 });
  });

  it('reports a final attempt that has no merchant event, and goes back to zero when it is repaired', async () => {
    const merchantId = await createMerchant(pg.db);
    const { attemptId } = await createAttemptInStatus(pg.db, 'failed', merchantId);
    await pg.db.deleteFrom('outbox_events').where('dedupe_key', '=', `payment.failed:attempt:${attemptId}`).execute();

    expect((await collectOperationalStats(pg.db)).attemptsMissingOutboxEvent).toBe(1);

    await enqueuePaymentEvent(pg.db, attemptId);
    expect((await collectOperationalStats(pg.db)).attemptsMissingOutboxEvent).toBe(0);
  });
});

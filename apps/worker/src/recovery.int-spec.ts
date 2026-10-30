import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { checkLedgerInvariants, findAttemptsMissingOutboxEvent, listOpenFindings, claimKey, attachAttempt } from '@app/db';
import { createAttemptInStatus, createMerchant, startMigratedPostgres, TestPostgres, uid } from '@app/testing';
import type { AttemptStatus } from '@app/payments-core';
import { FakeProcessorModule } from '../../fake-processor/src/fake-processor.module';
import { ProcessorLookup } from './processor-lookup';
import { Reconciler } from './reconciler';
import { RecoverySweeper } from './recovery-sweeper';

/**
 * Stage 9 worker, against a real Postgres and the real fake processor over HTTP: the sweeper and the
 * reconciler see exactly what production code would see.
 */
describe('recovery and reconciliation (worker + Postgres + fake processor)', () => {
  let pg: TestPostgres;
  let processorApp: NestExpressApplication;
  let base: string;
  let lookup: ProcessorLookup;
  // Rows are written with the real clock, so the test clock starts in the future and only moves forward.
  let clock: Date;
  const minutes = (n: number) => n * 60_000;
  const policy = { stuckAfterMs: minutes(2), abandonedGraceMs: minutes(25 * 60) };

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    const mod = await Test.createTestingModule({ imports: [FakeProcessorModule] }).compile();
    processorApp = mod.createNestApplication<NestExpressApplication>({ logger: false });
    await processorApp.listen(0, '127.0.0.1');
    base = (await processorApp.getUrl()).replace('[::1]', '127.0.0.1');
    lookup = new ProcessorLookup({ baseUrl: base, timeoutMs: 2000 });
  });

  afterAll(async () => {
    await processorApp?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    await fetch(`${base}/_control/reset`, { method: 'POST' });
    await pg.db.deleteFrom('reconciliation_findings').execute();
    clock = new Date(Date.now() + minutes(10));
  });

  afterEach(async () => {
    expect(await checkLedgerInvariants(pg.db)).toEqual([]);
    expect(await findAttemptsMissingOutboxEvent(pg.db)).toEqual([]);
  });

  const sweeper = (over: Partial<ConstructorParameters<typeof RecoverySweeper>[2]> = {}, lk = lookup) =>
    new RecoverySweeper(pg.db, lk, {
      ...policy,
      pendingAfterMs: minutes(15),
      claimStaleAfterMs: minutes(5),
      batchSize: 100,
      concurrency: 4,
      feeBps: 150,
      now: () => clock,
      ...over,
    });
  const reconciler = (lk = lookup) =>
    new Reconciler(pg.db, lk, { ...policy, lookbackMs: minutes(48 * 60), feeBps: 150, now: () => clock });

  /** An attempt of 5000 NGN in `status`, with the idempotency key its request would have left behind. */
  async function arrange(status: AttemptStatus, withKey = true) {
    const merchantId = await createMerchant(pg.db);
    const seeded = await createAttemptInStatus(pg.db, status, merchantId);
    const row = await pg.db.selectFrom('payment_attempts').select('processor_idempotency_key').where('id', '=', seeded.attemptId).executeTakeFirstOrThrow();
    let key: string | undefined;
    if (withKey) {
      key = `key-${uid()}`;
      await claimKey(pg.db, { merchantId, key, request: { operation: 'op', body: { n: seeded.attemptId } } });
      await attachAttempt(pg.db, merchantId, key, seeded.attemptId);
    }
    return { ...seeded, merchantId, key, reference: row.processor_idempotency_key };
  }

  /** What the processor holds: a charge carrying `reference`, whose outcome the source token picks. */
  async function charge(reference: string, over: { source?: string; amount?: number } = {}) {
    const res = await fetch(`${base}/v1/charges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': reference },
      body: JSON.stringify({ amount: over.amount ?? 5000, currency: 'NGN', source: over.source ?? 'tok_default', metadata: { reference } }),
    });
    expect([200, 402]).toContain(res.status); // 402: the charge exists, and it is a decline
    return (await res.json()) as { id: string; status: string };
  }

  const attemptRow = (id: number) => pg.db.selectFrom('payment_attempts').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const keyRow = (merchantId: number, key: string) =>
    pg.db.selectFrom('idempotency_keys').selectAll().where('merchant_id', '=', merchantId).where('idempotency_key', '=', key).executeTakeFirstOrThrow();
  const postings = async (attemptId: number) =>
    (await pg.db.selectFrom('ledger_transactions').select('id').where('posting_key', '=', `attempt:${attemptId}:succeeded`).execute()).length;
  const unreachable = new ProcessorLookup({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });

  describe('sweeper', () => {
    it('finishes a stuck call whose charge succeeded: attempt succeeded, one posting, key completed', async () => {
      const a = await arrange('calling_processor');
      await charge(a.reference);

      const summary = await sweeper().runOnce();

      expect(summary.applied).toBeGreaterThanOrEqual(1);
      expect((await attemptRow(a.attemptId)).status).toBe('succeeded');
      expect(await postings(a.attemptId)).toBe(1);
      expect((await keyRow(a.merchantId, a.key!)).completed_at).not.toBeNull();
    });

    it('records a decline as failed, with the processor failure code', async () => {
      const a = await arrange('calling_processor');
      await charge(a.reference, { source: 'tok_declined' });
      await sweeper().runOnce();
      const row = await attemptRow(a.attemptId);
      expect(row.status).toBe('failed');
      expect(row.failure_reason).toContain('card_declined');
      expect(await postings(a.attemptId)).toBe(0);
    });

    it('moves a pending charge to processing and a requires_action charge to requires_action', async () => {
      const p = await arrange('calling_processor', false);
      const r = await arrange('calling_processor', false);
      await charge(p.reference, { source: 'tok_pending' });
      await charge(r.reference, { source: 'tok_requires_action' });
      await sweeper().runOnce();
      expect((await attemptRow(p.attemptId)).status).toBe('processing');
      expect((await attemptRow(r.attemptId)).status).toBe('requires_action');
    });

    it('settles a processing attempt once the processor has resolved the charge (webhook never came)', async () => {
      const a = await arrange('processing', false);
      const c = await charge(a.reference, { source: 'tok_pending' });
      await fetch(`${base}/_control/charges/${c.id}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome: 'succeeded' }),
      });
      clock = new Date(clock.getTime() + minutes(30)); // past the pending threshold
      await sweeper().runOnce();
      expect((await attemptRow(a.attemptId)).status).toBe('succeeded');
      expect(await postings(a.attemptId)).toBe(1);
    });

    it('settles an abandoned attempt whose charge turns out to exist', async () => {
      const a = await arrange('abandoned', false);
      await charge(a.reference);
      await sweeper().runOnce();
      expect((await attemptRow(a.attemptId)).status).toBe('succeeded');
      expect(await postings(a.attemptId)).toBe(1);
    });

    it('abandons a stuck call the processor never heard of, and fails it only after the grace period', async () => {
      const a = await arrange('calling_processor');

      await sweeper().runOnce();
      expect((await attemptRow(a.attemptId)).status).toBe('abandoned');

      clock = new Date(clock.getTime() + minutes(60)); // well inside the 25 hour grace
      await sweeper().runOnce();
      expect((await attemptRow(a.attemptId)).status).toBe('abandoned');
      // The key was answered when the attempt was abandoned: "still processing", pointing at the payment.
      // The client polls the payment; the stored answer is not rewritten later (documented in the README).
      const abandonedKey = await keyRow(a.merchantId, a.key!);
      expect(abandonedKey.completed_at).not.toBeNull();
      expect(abandonedKey.response_status).toBe(202);

      clock = new Date(clock.getTime() + minutes(25 * 60));
      await sweeper().runOnce();
      const row = await attemptRow(a.attemptId);
      expect(row.status).toBe('failed');
      expect(row.failure_reason).toMatch(/^never_reached_processor/);
      expect((await keyRow(a.merchantId, a.key!)).completed_at).not.toBeNull();
    });

    it('leaves a young call alone', async () => {
      const a = await arrange('calling_processor', false);
      clock = new Date(Date.now()); // not idle long enough
      await sweeper().runOnce();
      expect((await attemptRow(a.attemptId)).status).toBe('calling_processor');
    });

    it('changes NOTHING when the processor cannot be asked', async () => {
      const a = await arrange('calling_processor');
      await charge(a.reference);

      const summary = await sweeper({}, unreachable).runOnce();

      expect(summary.lookupErrors).toBeGreaterThanOrEqual(1);
      expect((await attemptRow(a.attemptId)).status).toBe('calling_processor');
      expect(await postings(a.attemptId)).toBe(0);

      await sweeper().runOnce(); // and the next healthy pass finishes the job
      expect((await attemptRow(a.attemptId)).status).toBe('succeeded');
    });

    it('does not abandon an attempt on a 5xx from the processor', async () => {
      const a = await arrange('calling_processor', false);
      const broken = new ProcessorLookup({ baseUrl: base, timeoutMs: 2000, fetch: async () => new Response('{}', { status: 503 }) });
      await sweeper({}, broken).runOnce();
      expect((await attemptRow(a.attemptId)).status).toBe('calling_processor');
    });

    it('completes a dead request’s key for an already-final attempt, and releases a claim that never got an attempt', async () => {
      const done = await arrange('succeeded');
      const merchantId = await createMerchant(pg.db);
      const key = `claim-${uid()}`;
      await claimKey(pg.db, { merchantId, key, request: { operation: 'op', body: { n: key } } });
      expect((await keyRow(done.merchantId, done.key!)).completed_at).toBeNull();

      clock = new Date(clock.getTime() + minutes(30));
      const summary = await sweeper().runOnce();

      expect((await keyRow(done.merchantId, done.key!)).completed_at).not.toBeNull();
      expect(summary.claimsReleased).toBeGreaterThanOrEqual(1);
      expect(await pg.db.selectFrom('idempotency_keys').select('idempotency_key').where('merchant_id', '=', merchantId).execute()).toEqual([]);
    });

    it('records a finding instead of overwriting when the charge disagrees on the amount', async () => {
      const a = await arrange('calling_processor', false);
      await charge(a.reference, { amount: 9999 });
      await sweeper().runOnce();
      expect((await attemptRow(a.attemptId)).status).toBe('calling_processor');
      const findings = await listOpenFindings(pg.db, 'amount_mismatch');
      expect(findings.filter((f) => f.attempt_id === a.attemptId)).toHaveLength(1);
    });

    it('is safe to run from several workers at once: one posting, one outbox event', async () => {
      const a = await arrange('calling_processor');
      await charge(a.reference);

      await Promise.all([1, 2, 3, 4, 5].map(() => sweeper().runOnce()));

      expect((await attemptRow(a.attemptId)).status).toBe('succeeded');
      expect(await postings(a.attemptId)).toBe(1);
      const events = await pg.db.selectFrom('outbox_events').select('id').where('dedupe_key', 'like', `%:attempt:${a.attemptId}`).execute();
      expect(events).toHaveLength(1);
    });
  });

  describe('reconciler', () => {
    it('repairs what the processor makes unambiguous', async () => {
      const a = await arrange('calling_processor', false);
      await charge(a.reference);
      const summary = await reconciler().runOnce();
      expect(summary.repaired).toBeGreaterThanOrEqual(1);
      expect((await attemptRow(a.attemptId)).status).toBe('succeeded');
    });

    it('flags money we marked failed but the processor took, and does NOT change the attempt', async () => {
      const a = await arrange('failed', false);
      await charge(a.reference);
      await reconciler().runOnce();
      expect((await attemptRow(a.attemptId)).status).toBe('failed');
      expect((await listOpenFindings(pg.db, 'paid_but_failed')).filter((f) => f.attempt_id === a.attemptId)).toHaveLength(1);
    });

    it('flags a success the processor has no record of, then closes the finding when the charge appears', async () => {
      const a = await arrange('succeeded', false);
      await reconciler().runOnce();
      expect((await listOpenFindings(pg.db, 'success_without_charge')).filter((f) => f.attempt_id === a.attemptId)).toHaveLength(1);

      await charge(a.reference);
      clock = new Date(clock.getTime() + minutes(60));
      const summary = await reconciler().runOnce();

      expect(summary.findingsClosed).toBeGreaterThanOrEqual(1);
      expect((await listOpenFindings(pg.db, 'success_without_charge')).filter((f) => f.attempt_id === a.attemptId)).toEqual([]);
    });

    it('flags a charge none of our attempts explains, once however often it is seen', async () => {
      const ref = `stranger-${uid()}`;
      const c = await charge(ref);
      await reconciler().runOnce();
      clock = new Date(clock.getTime() + minutes(60));
      await reconciler().runOnce();
      const found = (await listOpenFindings(pg.db, 'orphan_charge')).filter((f) => f.charge_id === c.id);
      expect(found).toHaveLength(1);
      expect(found[0].seen_count).toBe(2);
    });

    it('a failed listing aborts the run and closes nothing', async () => {
      const a = await arrange('succeeded', false);
      await reconciler().runOnce();
      await charge(a.reference); // the discrepancy is gone...
      clock = new Date(clock.getTime() + minutes(60));

      await expect(reconciler(unreachable).runOnce()).rejects.toThrow(/unreachable/); // ...but we could not look
      expect((await listOpenFindings(pg.db, 'success_without_charge')).filter((f) => f.attempt_id === a.attemptId)).toHaveLength(1);
    });
  });
});

import type { AttemptStatus, RecoveryDecision } from '../../payments-core/src';
import { createAttemptInStatus, createMerchant, startMigratedPostgres, TestPostgres, uid } from '../../testing/src';
import { attachAttempt, claimKey } from './idempotency';
import { checkLedgerInvariants } from './invariants';
import { findAttemptsMissingOutboxEvent } from './outbox';
import {
  applyRecoveryDecision,
  completeOpenKeyForAttempt,
  completeOrphanedKeys,
  findRecoveryCandidates,
  ingestWebhookAttentionAsFindings,
  listOpenFindings,
  recordFinding,
  releaseStaleClaims,
  resolveFinding,
  resolveFindingsNoLongerObserved,
  loadAttemptsForReconciliation,
} from './recovery';
import type { RecoveryCandidate } from './recovery';

describe('recovery (real Postgres)', () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  afterEach(async () => {
    expect(await checkLedgerInvariants(pg.db)).toEqual([]);
    expect(await findAttemptsMissingOutboxEvent(pg.db)).toEqual([]);
  });

  const minutes = (n: number) => n * 60_000;
  const after = (ms: number) => new Date(Date.now() + ms);

  /** An attempt in `status`, optionally with the idempotency key its request left behind. */
  async function arrange(status: AttemptStatus, withKey = true) {
    const merchantId = await createMerchant(pg.db);
    const seeded = await createAttemptInStatus(pg.db, status, merchantId);
    let key: string | undefined;
    if (withKey) {
      key = `key-${uid()}`;
      await claimKey(pg.db, { merchantId, key, request: { operation: 'op', body: { n: seeded.attemptId } } });
      await attachAttempt(pg.db, merchantId, key, seeded.attemptId);
    }
    return { ...seeded, merchantId, key };
  }

  const candidateOf = async (attemptId: number, now = after(minutes(5))): Promise<RecoveryCandidate> => {
    const found = await findRecoveryCandidates(pg.db, { now, stuckAfterMs: 0, pendingAfterMs: 0, limit: 1000 });
    const c = found.find((x) => x.attemptId === attemptId);
    if (!c) throw new Error(`attempt ${attemptId} is not a candidate`);
    return c;
  };
  const attemptRow = (id: number) => pg.db.selectFrom('payment_attempts').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const keyRow = (merchantId: number, key: string) =>
    pg.db.selectFrom('idempotency_keys').selectAll().where('merchant_id', '=', merchantId).where('idempotency_key', '=', key).executeTakeFirst();
  const postings = async (attemptId: number) =>
    (await pg.db.selectFrom('ledger_transactions').select('id').where('posting_key', '=', `attempt:${attemptId}:succeeded`).execute()).length;
  const outboxTypes = async (attemptId: number) =>
    (await pg.db.selectFrom('outbox_events').select('event_type').where('dedupe_key', 'like', `%:attempt:${attemptId}`).execute()).map((e) => e.event_type);

  describe('findRecoveryCandidates', () => {
    it('selects stuck calls and abandoned attempts after the stuck threshold, pending ones after theirs, never final ones', async () => {
      const calling = await arrange('calling_processor', false);
      const abandoned = await arrange('abandoned', false);
      const processing = await arrange('processing', false);
      const requiresAction = await arrange('requires_action', false);
      const succeeded = await arrange('succeeded', false);
      const failed = await arrange('failed', false);
      const created = await arrange('created', false);
      const ids = (found: RecoveryCandidate[]) => found.map((c) => c.attemptId);
      const mine = new Set([calling, abandoned, processing, requiresAction, succeeded, failed, created].map((a) => a.attemptId));
      const find = async (now: Date) =>
        ids(await findRecoveryCandidates(pg.db, { now, stuckAfterMs: minutes(2), pendingAfterMs: minutes(15), limit: 1000 })).filter((id) => mine.has(id));

      expect(await find(after(minutes(1)))).toEqual([]); // nothing is old enough yet
      expect((await find(after(minutes(3)))).sort()).toEqual([calling.attemptId, abandoned.attemptId].sort());
      expect((await find(after(minutes(16)))).sort()).toEqual(
        [calling.attemptId, abandoned.attemptId, processing.attemptId, requiresAction.attemptId].sort(),
      );
    });

    it('describes each candidate with what the decision needs', async () => {
      const a = await arrange('processing', false);
      const c = await candidateOf(a.attemptId, after(minutes(20)));
      expect(c).toMatchObject({
        attemptId: a.attemptId,
        intentId: a.intentId,
        merchantId: a.merchantId,
        status: 'processing',
        amount: 5000,
        currency: 'NGN',
      });
      expect(c.chargeId).toBeNull(); // the seed gives a processing attempt no charge id
      expect(c.reference).toMatch(/^pi_\d+_a1_/);
      expect(c.idleMs).toBeGreaterThanOrEqual(minutes(19));
      expect(c.ageMs).toBeGreaterThanOrEqual(c.idleMs);
    });

    it('returns the oldest first and honours the limit', async () => {
      const first = await arrange('calling_processor', false);
      await arrange('calling_processor', false);
      const found = await findRecoveryCandidates(pg.db, { now: after(minutes(5)), stuckAfterMs: 0, pendingAfterMs: 0, limit: 1 });
      expect(found).toHaveLength(1);
      expect(found[0].idleMs).toBeGreaterThanOrEqual(0);
      expect(found[0].attemptId).toBeLessThanOrEqual(first.attemptId + 1000); // sanity: it is a real attempt
    });
  });

  describe('applyRecoveryDecision', () => {
    const feeBps = 150;
    const succeeded = (chargeId: string): RecoveryDecision => ({ action: 'apply', outcome: { kind: 'succeeded', chargeId } });

    it('applies a success: attempt, ledger, merchant event and the dead request\'s key, together', async () => {
      const a = await arrange('calling_processor');
      const result = await applyRecoveryDecision(pg.db, await candidateOf(a.attemptId), succeeded(`ch_${uid()}`), { feeBps });

      expect(result).toEqual({ applied: true, attemptStatus: 'succeeded' });
      expect(await attemptRow(a.attemptId)).toMatchObject({ status: 'succeeded' });
      expect(await postings(a.attemptId)).toBe(1);
      expect(await outboxTypes(a.attemptId)).toEqual(['payment.succeeded']);
      const key = await keyRow(a.merchantId, a.key as string);
      expect(key?.completed_at).not.toBeNull();
      expect(key).toMatchObject({ response_status: 201, response_body: { status: 'succeeded', id: `pay_${a.intentId}` } });
    });

    it('steps a requires_action attempt through processing to succeeded', async () => {
      const a = await arrange('requires_action');
      expect(await applyRecoveryDecision(pg.db, await candidateOf(a.attemptId), succeeded(`ch_${uid()}`), { feeBps })).toMatchObject({ applied: true });
      expect(await attemptRow(a.attemptId)).toMatchObject({ status: 'succeeded' });
      expect(await postings(a.attemptId)).toBe(1);
    });

    it('applies a decline with its code, tells the merchant, and stores a 402 under the key', async () => {
      const a = await arrange('processing');
      const decision: RecoveryDecision = { action: 'apply', outcome: { kind: 'declined', code: 'insufficient_funds', chargeId: 'ch_x' } };
      expect(await applyRecoveryDecision(pg.db, await candidateOf(a.attemptId), decision, { feeBps })).toMatchObject({ applied: true, attemptStatus: 'failed' });
      expect(await attemptRow(a.attemptId)).toMatchObject({ status: 'failed', failure_reason: 'insufficient_funds' });
      expect(await outboxTypes(a.attemptId)).toEqual(['payment.failed']);
      expect((await keyRow(a.merchantId, a.key as string))?.response_status).toBe(402);
    });

    it('moves a calling_processor attempt to processing when the charge is pending', async () => {
      const a = await arrange('calling_processor');
      const decision: RecoveryDecision = { action: 'apply', outcome: { kind: 'processing', chargeId: `ch_${uid()}` } };
      expect(await applyRecoveryDecision(pg.db, await candidateOf(a.attemptId), decision, { feeBps })).toMatchObject({ attemptStatus: 'processing' });
      expect((await keyRow(a.merchantId, a.key as string))?.response_status).toBe(202);
    });

    it('abandons a call nobody answered: unknown, still blocking, with a "processing" answer under the key', async () => {
      const a = await arrange('calling_processor');
      expect(await applyRecoveryDecision(pg.db, await candidateOf(a.attemptId), { action: 'abandon' }, { feeBps })).toEqual({
        applied: true,
        attemptStatus: 'abandoned',
      });
      expect(await attemptRow(a.attemptId)).toMatchObject({ status: 'abandoned' });
      expect((await keyRow(a.merchantId, a.key as string))?.response_status).toBe(202);
      // an unknown outcome must keep the order blocked
      await expect(
        pg.db
          .insertInto('payment_attempts')
          .values({ payment_intent_id: a.intentId, attempt_number: 2, processor_idempotency_key: `pi_${a.intentId}_a2_${uid()}`, payment_source: 'tok_test' })
          .execute(),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('fails an abandoned attempt that never reached the processor, as a 502, and tells the merchant', async () => {
      const a = await arrange('abandoned');
      expect(await applyRecoveryDecision(pg.db, await candidateOf(a.attemptId), { action: 'fail_unreached' }, { feeBps })).toMatchObject({
        applied: true,
        attemptStatus: 'failed',
      });
      expect(await attemptRow(a.attemptId)).toMatchObject({ status: 'failed', failure_reason: 'never_reached_processor' });
      expect(await outboxTypes(a.attemptId)).toEqual(['payment.failed']);
      expect((await keyRow(a.merchantId, a.key as string))?.response_status).toBe(502);
    });

    it('reports stale, and changes nothing, when someone else moved the attempt first', async () => {
      const a = await arrange('calling_processor');
      const candidate = await candidateOf(a.attemptId);
      // a webhook gets there while the sweeper is still thinking
      await applyRecoveryDecision(pg.db, candidate, succeeded(`ch_${uid()}`), { feeBps });

      expect(await applyRecoveryDecision(pg.db, candidate, { action: 'abandon' }, { feeBps })).toEqual({ applied: false, reason: 'stale' });
      expect(await attemptRow(a.attemptId)).toMatchObject({ status: 'succeeded' });
    });

    it.each<[RecoveryDecision['action'], RecoveryDecision]>([
      ['none', { action: 'none' }],
      ['wait', { action: 'wait', reason: 'later' }],
      ['finding', { action: 'finding', kind: 'charge_missing', detail: 'x' }],
    ])('does not touch the attempt for %s', async (_name, decision) => {
      const a = await arrange('processing', false);
      const before = await attemptRow(a.attemptId);
      expect((await applyRecoveryDecision(pg.db, await candidateOf(a.attemptId), decision, { feeBps })).applied).toBe(false);
      expect(await attemptRow(a.attemptId)).toEqual(before);
    });

    it('with many sweepers racing on one attempt, exactly one applies and the books hold one posting', async () => {
      const a = await arrange('calling_processor');
      const candidate = await candidateOf(a.attemptId);
      const chargeId = `ch_${uid()}`;
      const results = await Promise.all(
        Array.from({ length: 6 }, () => applyRecoveryDecision(pg.db, candidate, succeeded(chargeId), { feeBps }).catch((e: Error) => e)),
      );
      expect(results.filter((r) => !(r instanceof Error) && r.applied)).toHaveLength(1);
      expect(await postings(a.attemptId)).toBe(1);
      expect(await outboxTypes(a.attemptId)).toEqual(['payment.succeeded']);
    });
  });

  describe('keys the dead request left behind', () => {
    it('completeOpenKeyForAttempt answers with the payment as it is now, once', async () => {
      const a = await arrange('processing');
      expect(await completeOpenKeyForAttempt(pg.db, a.attemptId)).toBe(true);
      expect((await keyRow(a.merchantId, a.key as string))?.response_status).toBe(202);
      expect(await completeOpenKeyForAttempt(pg.db, a.attemptId)).toBe(false); // already complete
    });

    it('is a no-op when the attempt has no key', async () => {
      const a = await arrange('processing', false);
      expect(await completeOpenKeyForAttempt(pg.db, a.attemptId)).toBe(false);
    });

    it('completeOrphanedKeys finishes keys whose attempt moved on without them, but not calls still in flight', async () => {
      const done = await arrange('succeeded');
      const waiting = await arrange('processing');
      const inFlight = await arrange('calling_processor');

      const n = await completeOrphanedKeys(pg.db, { now: after(minutes(10)), olderThanMs: minutes(5), limit: 1000 });
      expect(n).toBeGreaterThanOrEqual(2);
      expect((await keyRow(done.merchantId, done.key as string))?.response_status).toBe(201);
      expect((await keyRow(waiting.merchantId, waiting.key as string))?.response_status).toBe(202);
      expect((await keyRow(inFlight.merchantId, inFlight.key as string))?.completed_at).toBeNull();
    });

    it('completeOrphanedKeys leaves young keys alone', async () => {
      const a = await arrange('succeeded');
      await completeOrphanedKeys(pg.db, { now: after(minutes(1)), olderThanMs: minutes(5), limit: 1000 });
      expect((await keyRow(a.merchantId, a.key as string))?.completed_at).toBeNull();
    });

    it('releaseStaleClaims frees claims that never produced an attempt, only when old enough', async () => {
      const merchantId = await createMerchant(pg.db);
      const key = `key-${uid()}`;
      await claimKey(pg.db, { merchantId, key, request: { operation: 'op', body: {} } });
      expect(await releaseStaleClaims(pg.db, { now: after(minutes(1)), olderThanMs: minutes(5) })).toBe(0);
      expect(await keyRow(merchantId, key)).toBeDefined();

      expect(await releaseStaleClaims(pg.db, { now: after(minutes(10)), olderThanMs: minutes(5) })).toBeGreaterThanOrEqual(1);
      expect(await keyRow(merchantId, key)).toBeUndefined();
    });

    it('releaseStaleClaims never frees a key that has an attempt (money may have moved)', async () => {
      const a = await arrange('calling_processor');
      await releaseStaleClaims(pg.db, { now: after(minutes(60)), olderThanMs: minutes(5) });
      expect(await keyRow(a.merchantId, a.key as string)).toBeDefined();
    });
  });

  describe('findings', () => {
    const t = (n: number) => new Date(Date.UTC(2030, 0, 1, 0, n));
    const input = (over: Record<string, unknown> = {}) => ({
      kind: 'paid_but_failed',
      source: 'reconciliation' as const,
      dedupeKey: `paid_but_failed:attempt:${uid()}`,
      detail: 'charge succeeded but attempt failed',
      now: t(0),
      ...over,
    });

    it('records a discrepancy once and counts the times it is seen again', async () => {
      const i = input();
      expect((await recordFinding(pg.db, i)).outcome).toBe('created');
      expect((await recordFinding(pg.db, { ...i, now: t(5), detail: 'still there' })).outcome).toBe('seen_again');
      const row = await pg.db.selectFrom('reconciliation_findings').selectAll().where('dedupe_key', '=', i.dedupeKey).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ seen_count: 2, status: 'open', detail: 'still there' });
      expect(row.first_seen_at).toEqual(t(0));
      expect(row.last_seen_at).toEqual(t(5));
    });

    it('lists open findings, optionally by kind', async () => {
      const a = input({ kind: 'orphan_charge' });
      const b = input({ kind: 'charge_missing' });
      await recordFinding(pg.db, a);
      await recordFinding(pg.db, b);
      expect((await listOpenFindings(pg.db, 'orphan_charge')).map((f) => f.dedupe_key)).toContain(a.dedupeKey);
      expect((await listOpenFindings(pg.db, 'orphan_charge')).map((f) => f.dedupe_key)).not.toContain(b.dedupeKey);
    });

    it('a finding resolved by a person stays resolved when the discrepancy is seen again', async () => {
      const i = input();
      const { id } = await recordFinding(pg.db, i);
      expect(await resolveFinding(pg.db, id, 'refunded manually, ticket 123', t(1))).toBe(true);
      await recordFinding(pg.db, { ...i, now: t(2) });
      const row = await pg.db.selectFrom('reconciliation_findings').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      expect(row).toMatchObject({ status: 'resolved', resolution: 'refunded manually, ticket 123', seen_count: 2 });
    });

    const statusOf = async (id: number) =>
      (await pg.db.selectFrom('reconciliation_findings').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
    const examined = (charges: string[], attempts: number[] = []) => ({
      examinedChargeIds: new Set(charges),
      examinedAttemptIds: new Set(attempts),
    });

    it('a finding the system closed because it was no longer observed reopens if it comes back', async () => {
      const charge = `ch_${uid()}`;
      const i = input({ dedupeKey: `x:${uid()}`, chargeId: charge });
      const { id } = await recordFinding(pg.db, i);
      await resolveFindingsNoLongerObserved(pg.db, { sources: ['reconciliation'], seenBefore: t(10), now: t(11), ...examined([charge]) });
      expect(await statusOf(id)).toBe('resolved');
      await recordFinding(pg.db, { ...i, now: t(20) });
      expect(await pg.db.selectFrom('reconciliation_findings').select(['status', 'resolution']).where('id', '=', id).executeTakeFirstOrThrow()).toEqual({ status: 'open', resolution: null });
    });

    it('closes only findings that were examined this pass, not seen again, and from the named sources', async () => {
      const [cSeen, cGone, cUnexamined, cWeb] = [1, 2, 3, 4].map(() => `ch_${uid()}`);
      const seen = await recordFinding(pg.db, input({ dedupeKey: `seen:${uid()}`, chargeId: cSeen, now: t(30) }));
      const gone = await recordFinding(pg.db, input({ dedupeKey: `gone:${uid()}`, chargeId: cGone, now: t(0) }));
      const unexamined = await recordFinding(pg.db, input({ dedupeKey: `un:${uid()}`, chargeId: cUnexamined, now: t(0) }));
      const web = await recordFinding(pg.db, input({ dedupeKey: `web:${uid()}`, chargeId: cWeb, now: t(0), source: 'webhook' as const }));

      const closed = await resolveFindingsNoLongerObserved(pg.db, {
        sources: ['recovery', 'reconciliation'],
        seenBefore: t(20),
        now: t(31),
        ...examined([cSeen, cGone, cWeb]),
      });
      expect(closed).toBe(1);
      expect(await statusOf(seen.id)).toBe('open'); // seen again this pass
      expect(await statusOf(gone.id)).toBe('resolved');
      expect(await statusOf(unexamined.id)).toBe('open'); // nobody looked: silence is not a fix
      expect(await statusOf(web.id)).toBe('open'); // webhook findings are not part of the comparison
    });

    it('closes an attempt finding when that attempt was examined', async () => {
      const a = await arrange('processing', false);
      const f = await recordFinding(pg.db, input({ dedupeKey: `a:${uid()}`, attemptId: a.attemptId, now: t(0) }));
      expect(await resolveFindingsNoLongerObserved(pg.db, { sources: ['reconciliation'], seenBefore: t(5), now: t(6), ...examined([], [a.attemptId]) })).toBe(1);
      expect(await statusOf(f.id)).toBe('resolved');
    });

    it('loadAttemptsForReconciliation takes recent attempts and every unresolved one, however old', async () => {
      const unresolved = await arrange('processing', false);
      const finalOld = await arrange('succeeded', false);
      const farFuture = new Date(Date.now() + 365 * 24 * minutes(60));
      const ids = (await loadAttemptsForReconciliation(pg.db, { now: farFuture, createdAfter: farFuture })).map((c) => c.attemptId);
      expect(ids).toContain(unresolved.attemptId);
      expect(ids).not.toContain(finalOld.attemptId);
      const recent = (await loadAttemptsForReconciliation(pg.db, { now: farFuture, createdAfter: new Date(0) })).map((c) => c.attemptId);
      expect(recent).toContain(finalOld.attemptId);
    });

    it('refuses to resolve without saying what was done', async () => {
      const { id } = await recordFinding(pg.db, input());
      await expect(resolveFinding(pg.db, id, '  ', t(1))).rejects.toThrow(/resolution/);
    });

    it('resolving twice reports false the second time', async () => {
      const { id } = await recordFinding(pg.db, input());
      expect(await resolveFinding(pg.db, id, 'done', t(1))).toBe(true);
      expect(await resolveFinding(pg.db, id, 'again', t(2))).toBe(false);
    });

    it('turns webhook events that need attention into findings, once, and never reopens them', async () => {
      const a = await arrange('processing', false);
      const event = await pg.db
        .insertInto('webhook_events')
        .values({ source: 'processor', event_id: `evt_${uid()}`, event_type: 'charge.succeeded', payload: JSON.stringify({ data: { object: { id: 'ch_zzz' } } }) })
        .returning('id')
        .executeTakeFirstOrThrow();
      await pg.db
        .updateTable('webhook_events')
        .set({ result: 'conflict', attempt_id: a.attemptId, detail: 'attempt is failed', processed_at: new Date() })
        .where('id', '=', event.id)
        .execute();

      expect(await ingestWebhookAttentionAsFindings(pg.db, t(0))).toBeGreaterThanOrEqual(1);
      const finding = await pg.db.selectFrom('reconciliation_findings').selectAll().where('dedupe_key', '=', `webhook_event:${event.id}`).executeTakeFirstOrThrow();
      expect(finding).toMatchObject({ kind: 'webhook_conflict', source: 'webhook', attempt_id: a.attemptId, charge_id: 'ch_zzz', status: 'open' });

      await resolveFinding(pg.db, finding.id, 'handled by support', t(1));
      expect(await ingestWebhookAttentionAsFindings(pg.db, t(2))).toBe(0);
      expect((await pg.db.selectFrom('reconciliation_findings').select('status').where('id', '=', finding.id).executeTakeFirstOrThrow()).status).toBe('resolved');
    });
  });
});

import { sql } from 'kysely';
import type { PaymentAttemptStatus } from '@app/db';
import {
  createAttempt,
  createAttemptInStatus,
  createIntent,
  createMerchant,
  expectSqlState,
  PG,
  setAttemptStatus,
  startMigratedPostgres,
  TestPostgres,
  uid,
} from '@app/testing';

/**
 * Stage 1.3: failure mode 2.7 ("two attempts for one order both succeed") made structurally
 * impossible, plus the guards that keep intents and attempts consistent with each other.
 */
describe('schema: attempt and intent integrity (0003)', () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  const intentOf = (id: number) =>
    pg.db.selectFrom('payment_intents').select('status').where('id', '=', id).executeTakeFirstOrThrow();

  describe('one active attempt per intent', () => {
    // 'succeeded' also closes the intent, so the insert guard answers before the unique index does.
    const ACTIVE: Array<[PaymentAttemptStatus, string]> = [
      ['created', PG.UNIQUE_VIOLATION],
      ['calling_processor', PG.UNIQUE_VIOLATION],
      ['processing', PG.UNIQUE_VIOLATION],
      ['requires_action', PG.UNIQUE_VIOLATION],
      ['abandoned', PG.UNIQUE_VIOLATION],
      ['succeeded', PG.INTEGRITY],
    ];

    it.each(ACTIVE)('blocks a second attempt while the first is %s', async (status, expectedCode) => {
      const { intentId } = await createAttemptInStatus(pg.db, status);

      await expectSqlState(createAttempt(pg.db, intentId, 2), expectedCode);
    });

    it('names the partial unique index when it is the thing that refused', async () => {
      const { intentId } = await createAttemptInStatus(pg.db, 'processing');

      await expectSqlState(
        createAttempt(pg.db, intentId, 2),
        PG.UNIQUE_VIOLATION,
        /payment_attempts_one_active_per_intent/,
      );
    });

    it('allows a new attempt once the previous one has failed, keeping the full history', async () => {
      const merchantId = await createMerchant(pg.db);
      const intentId = await createIntent(pg.db, merchantId);

      for (let n = 1; n <= 3; n++) {
        const attemptId = await createAttempt(pg.db, intentId, n);
        await setAttemptStatus(pg.db, attemptId, 'calling_processor');
        await setAttemptStatus(pg.db, attemptId, 'failed');
      }
      const fourth = await createAttempt(pg.db, intentId, 4);

      const rows = await pg.db
        .selectFrom('payment_attempts')
        .select(['attempt_number', 'status'])
        .where('payment_intent_id', '=', intentId)
        .orderBy('attempt_number')
        .execute();
      expect(rows.map((r) => r.status)).toEqual(['failed', 'failed', 'failed', 'created']);
      expect(fourth).toEqual(expect.any(Number));
    });

    it('keeps an unknown outcome blocking: abandoned must be resolved before a retry is allowed', async () => {
      const { intentId, attemptId } = await createAttemptInStatus(pg.db, 'abandoned');

      // We do not know whether the processor charged the card, so a second charge is not safe.
      await expectSqlState(createAttempt(pg.db, intentId, 2), PG.UNIQUE_VIOLATION);

      // Reconciliation discovers the charge never happened. Now a retry is safe.
      await setAttemptStatus(pg.db, attemptId, 'failed');
      await expect(createAttempt(pg.db, intentId, 2)).resolves.toEqual(expect.any(Number));
    });

    it('closes the double-charge window: an abandoned attempt that later succeeded had no rival', async () => {
      const { intentId, attemptId } = await createAttemptInStatus(pg.db, 'abandoned');
      await expectSqlState(createAttempt(pg.db, intentId, 2), PG.UNIQUE_VIOLATION);

      await setAttemptStatus(pg.db, attemptId, 'succeeded');

      expect((await intentOf(intentId)).status).toBe('succeeded');
      const { n } = await pg.db
        .selectFrom('payment_attempts')
        .select(sql<number>`count(*)`.as('n'))
        .where('payment_intent_id', '=', intentId)
        .executeTakeFirstOrThrow();
      expect(n).toBe(1);
    });

    it('has exactly one winner when many attempts are created at the same instant', async () => {
      const intentId = await createIntent(pg.db, await createMerchant(pg.db));

      // The atomic-claim race from Module 2, one level up: 20 workers, same order, different
      // attempt numbers and keys, all trying to start charging.
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) => createAttempt(pg.db, intentId, i + 1)),
      );

      const winners = results.filter((r) => r.status === 'fulfilled');
      const losers = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(19);
      for (const loser of losers) {
        expect((loser.reason as { code?: string }).code).toBe(PG.UNIQUE_VIOLATION);
      }
    });
  });

  describe('no attempt on an intent that is not open', () => {
    it('refuses an attempt for an intent that does not exist', async () => {
      await expectSqlState(
        pg.db
          .insertInto('payment_attempts')
          .values({ payment_intent_id: 999_999_999, attempt_number: 1, processor_idempotency_key: `k-${uid()}`, payment_source: 'tok_test' })
          .execute(),
        PG.INTEGRITY,
        /missing/,
      );
    });

    it('refuses an attempt for a canceled intent', async () => {
      const intentId = await createIntent(pg.db, await createMerchant(pg.db));
      await pg.db.updateTable('payment_intents').set({ status: 'canceled' }).where('id', '=', intentId).execute();

      await expectSqlState(createAttempt(pg.db, intentId), PG.INTEGRITY, /canceled/);
    });

    it('refuses an attempt for an intent that already succeeded', async () => {
      const { intentId } = await createAttemptInStatus(pg.db, 'succeeded');

      await expectSqlState(createAttempt(pg.db, intentId, 2), PG.INTEGRITY, /succeeded/);
    });
  });

  describe('intent terminal states match their attempts', () => {
    it('cannot be marked succeeded by hand, without a succeeded attempt', async () => {
      const intentId = await createIntent(pg.db, await createMerchant(pg.db));

      await expectSqlState(
        pg.db.updateTable('payment_intents').set({ status: 'succeeded' }).where('id', '=', intentId).execute(),
        PG.INTEGRITY,
        /without a succeeded attempt/,
      );
    });

    it('cannot be marked succeeded when its only attempt is still processing', async () => {
      const { intentId } = await createAttemptInStatus(pg.db, 'processing');

      await expectSqlState(
        pg.db.updateTable('payment_intents').set({ status: 'succeeded' }).where('id', '=', intentId).execute(),
        PG.INTEGRITY,
      );
    });

    it.each(['created', 'calling_processor', 'processing', 'requires_action', 'abandoned'] as const)(
      'cannot be canceled while an attempt is %s, because money may be moving',
      async (status) => {
        const { intentId } = await createAttemptInStatus(pg.db, status);

        await expectSqlState(
          pg.db.updateTable('payment_intents').set({ status: 'canceled' }).where('id', '=', intentId).execute(),
          PG.INTEGRITY,
          /while an attempt is active/,
        );
        expect((await intentOf(intentId)).status).toBe('open');
      },
    );

    it('can be canceled when every attempt has failed', async () => {
      const { intentId } = await createAttemptInStatus(pg.db, 'failed');

      await pg.db.updateTable('payment_intents').set({ status: 'canceled' }).where('id', '=', intentId).execute();

      expect((await intentOf(intentId)).status).toBe('canceled');
    });

    it('can be canceled when it has no attempts at all', async () => {
      const intentId = await createIntent(pg.db, await createMerchant(pg.db));

      await pg.db.updateTable('payment_intents').set({ status: 'canceled' }).where('id', '=', intentId).execute();

      expect((await intentOf(intentId)).status).toBe('canceled');
    });
  });

  describe('cancel racing against a new attempt', () => {
    it('never ends with a canceled intent that has a live attempt', async () => {
      const merchantId = await createMerchant(pg.db);
      const ITERATIONS = 40;
      let canceledWins = 0;
      let attemptWins = 0;

      for (let i = 0; i < ITERATIONS; i++) {
        const intentId = await createIntent(pg.db, merchantId);

        const [attemptResult, cancelResult] = await Promise.allSettled([
          createAttempt(pg.db, intentId, 1),
          pg.db.updateTable('payment_intents').set({ status: 'canceled' }).where('id', '=', intentId).execute(),
        ]);

        // Exactly one side wins; the loser is refused cleanly by the integrity guard.
        const fulfilled = [attemptResult, cancelResult].filter((r) => r.status === 'fulfilled').length;
        expect(fulfilled).toBe(1);
        for (const result of [attemptResult, cancelResult]) {
          if (result.status === 'rejected') {
            expect((result.reason as { code?: string }).code).toBe(PG.INTEGRITY);
          }
        }

        const { rows } = await sql<{ canceled: boolean; has_active: boolean }>`
          select
            i.status = 'canceled' as canceled,
            exists (select 1 from payment_attempts a where a.payment_intent_id = i.id and a.status <> 'failed') as has_active
          from payment_intents i where i.id = ${intentId}
        `.execute(pg.db);

        expect(rows[0].canceled && rows[0].has_active).toBe(false);
        if (attemptResult.status === 'fulfilled') attemptWins++;
        else canceledWins++;
      }

      // Not asserted, but handy when reading test output: both orders should occur over many runs.
      console.log(`cancel-vs-attempt race over ${ITERATIONS} runs: attempt won ${attemptWins}, cancel won ${canceledWins}`);
    });
  });
});

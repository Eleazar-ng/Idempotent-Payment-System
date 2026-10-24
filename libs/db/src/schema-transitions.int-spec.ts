import { sql } from 'kysely';
import type { PaymentAttemptStatus } from '@app/db';
import {
  advanceAttemptTo,
  createAttempt,
  createAttemptInStatus,
  createIntent,
  createMerchant,
  expectSqlState,
  PG,
  setAttemptStatus,
  startMigratedPostgres,
  TestPostgres,
} from '@app/testing';

/**
 * Stage 1.2: the state machine, enforced by the database.
 *
 * ALLOWED below is a deliberate second copy of the Module 5 transition table. If someone edits the
 * SQL table without consciously updating this test (or the reverse), a test fails. That is the point.
 */

const ATTEMPT_STATUSES: PaymentAttemptStatus[] = [
  'created',
  'calling_processor',
  'processing',
  'requires_action',
  'succeeded',
  'failed',
  'abandoned',
];

const ALLOWED: Record<PaymentAttemptStatus, PaymentAttemptStatus[]> = {
  created: ['calling_processor'],
  calling_processor: ['processing', 'requires_action', 'succeeded', 'failed', 'abandoned'],
  processing: ['requires_action', 'succeeded', 'failed', 'abandoned'],
  requires_action: ['processing', 'failed'],
  succeeded: [], // terminal
  failed: [], // terminal
  abandoned: ['succeeded', 'failed'], // reconciliation resolves it
};

describe('schema: status transitions (0002)', () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  describe('the reference tables', () => {
    it('contain exactly the transitions this test expects, no more and no fewer', async () => {
      const rows = await pg.db
        .selectFrom('status_transitions')
        .select(['from_status', 'to_status'])
        .where('entity', '=', 'payment_attempt')
        .execute();

      const actual = rows.map((r) => `${r.from_status}->${r.to_status}`).sort();
      const expected = Object.entries(ALLOWED)
        .flatMap(([from, targets]) => targets.map((to) => `${from}->${to}`))
        .sort();

      expect(actual).toEqual(expected);
    });

    it('define the payment intent machine as open -> succeeded and open -> canceled only', async () => {
      const rows = await pg.db
        .selectFrom('status_transitions')
        .select(['from_status', 'to_status'])
        .where('entity', '=', 'payment_intent')
        .execute();

      expect(rows.map((r) => `${r.from_status}->${r.to_status}`).sort()).toEqual([
        'open->canceled',
        'open->succeeded',
      ]);
    });
  });

  describe('initial states', () => {
    it('cannot create an attempt directly in a later state, skipping the machine', async () => {
      const intentId = await createIntent(pg.db, await createMerchant(pg.db));

      await expectSqlState(
        pg.db
          .insertInto('payment_attempts')
          .values({
            payment_intent_id: intentId,
            attempt_number: 1,
            processor_idempotency_key: 'skip-the-machine',
            payment_source: 'tok_test',
            status: 'succeeded',
            processor_charge_id: 'ch_forged',
          })
          .execute(),
        PG.INVALID_TRANSITION,
        /Invalid initial payment_attempt status/,
      );
    });

    it('cannot create an attempt with a status that does not exist', async () => {
      const intentId = await createIntent(pg.db, await createMerchant(pg.db));

      await expectSqlState(
        pg.db
          .insertInto('payment_attempts')
          .values({
            payment_intent_id: intentId,
            attempt_number: 1,
            processor_idempotency_key: 'bogus-status',
            payment_source: 'tok_test',
            status: 'bogus' as never,
          })
          .execute(),
        PG.INVALID_TRANSITION,
      );
    });

    it('cannot create an intent already succeeded or canceled', async () => {
      const merchantId = await createMerchant(pg.db);
      for (const status of ['succeeded', 'canceled'] as const) {
        await expectSqlState(
          pg.db
            .insertInto('payment_intents')
            .values({ merchant_id: merchantId, order_id: `o-${status}`, amount: 100, currency: 'NGN', status })
            .execute(),
          PG.INVALID_TRANSITION,
        );
      }
    });
  });

  describe('every attempt transition (table-driven: 7 states x 7 targets)', () => {
    const cases = ATTEMPT_STATUSES.flatMap((from) => ATTEMPT_STATUSES.map((to) => ({ from, to })));

    it.each(cases)('$from -> $to', async ({ from, to }) => {
      const { attemptId } = await createAttemptInStatus(pg.db, from);

      // Staying in the same state is a harmless no-op, always allowed.
      const move =
        from === to
          ? pg.db.updateTable('payment_attempts').set({ status: from }).where('id', '=', attemptId).execute()
          : setAttemptStatus(pg.db, attemptId, to);

      if (from === to || ALLOWED[from].includes(to)) {
        await move;
        const row = await pg.db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow();
        expect(row.status).toBe(to);
      } else {
        await expectSqlState(move, PG.INVALID_TRANSITION, new RegExp(`${from} -> ${to}`));
        const row = await pg.db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow();
        expect(row.status).toBe(from); // the refused write changed nothing
      }
    });
  });

  describe('the late-event scenarios the transition table exists for (Module 5.6)', () => {
    it('a stale "failed" webhook cannot overwrite a confirmed success', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'succeeded');

      await expectSqlState(setAttemptStatus(pg.db, attemptId, 'failed'), PG.INVALID_TRANSITION);
    });

    it('a stale "processing" event cannot pull a succeeded attempt backwards', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'succeeded');

      await expectSqlState(setAttemptStatus(pg.db, attemptId, 'processing'), PG.INVALID_TRANSITION);
    });

    it('a timeout job cannot fail an attempt that already succeeded (Module 4.3)', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'processing');
      await setAttemptStatus(pg.db, attemptId, 'succeeded'); // the real completion wins first

      // The job's stale decision, written the careless way: no "AND status = 'processing'".
      await expectSqlState(
        pg.db
          .updateTable('payment_attempts')
          .set({ status: 'failed', failure_reason: 'timed_out' })
          .where('id', '=', attemptId)
          .execute(),
        PG.INVALID_TRANSITION,
      );
    });

    it('reconciliation may resolve an abandoned attempt either way', async () => {
      const resolvedToSuccess = await createAttemptInStatus(pg.db, 'abandoned');
      const resolvedToFailure = await createAttemptInStatus(pg.db, 'abandoned');

      await setAttemptStatus(pg.db, resolvedToSuccess.attemptId, 'succeeded');
      await setAttemptStatus(pg.db, resolvedToFailure.attemptId, 'failed');

      const rows = await pg.db
        .selectFrom('payment_attempts')
        .select(['id', 'status'])
        .where('id', 'in', [resolvedToSuccess.attemptId, resolvedToFailure.attemptId])
        .execute();
      expect(rows.find((r) => r.id === resolvedToSuccess.attemptId)?.status).toBe('succeeded');
      expect(rows.find((r) => r.id === resolvedToFailure.attemptId)?.status).toBe('failed');
    });
  });

  describe('payment intent machine', () => {
    it('can be canceled while open and has no way back', async () => {
      const intentId = await createIntent(pg.db, await createMerchant(pg.db));
      const set = (status: 'open' | 'succeeded' | 'canceled') =>
        pg.db.updateTable('payment_intents').set({ status }).where('id', '=', intentId).execute();

      await set('canceled');

      await expectSqlState(set('open'), PG.INVALID_TRANSITION);
      await expectSqlState(set('succeeded'), PG.INVALID_TRANSITION);
    });

    it('is terminal once succeeded', async () => {
      const { intentId } = await createAttemptInStatus(pg.db, 'succeeded');
      const set = (status: 'open' | 'canceled') =>
        pg.db.updateTable('payment_intents').set({ status }).where('id', '=', intentId).execute();

      await expectSqlState(set('open'), PG.INVALID_TRANSITION);
      await expectSqlState(set('canceled'), PG.INVALID_TRANSITION);
    });
  });

  describe('success propagation: attempt -> intent (Module 5.10)', () => {
    const intentStatus = async (intentId: number) =>
      (await pg.db.selectFrom('payment_intents').select('status').where('id', '=', intentId).executeTakeFirstOrThrow()).status;

    it('marks the intent succeeded in the same transaction as the attempt', async () => {
      const { intentId, attemptId } = await createAttemptInStatus(pg.db, 'processing');
      expect(await intentStatus(intentId)).toBe('open');

      await setAttemptStatus(pg.db, attemptId, 'succeeded');

      expect(await intentStatus(intentId)).toBe('succeeded');
    });

    it('also propagates when reconciliation resolves an abandoned attempt to succeeded', async () => {
      const { intentId, attemptId } = await createAttemptInStatus(pg.db, 'abandoned');
      expect(await intentStatus(intentId)).toBe('open');

      await setAttemptStatus(pg.db, attemptId, 'succeeded');

      expect(await intentStatus(intentId)).toBe('succeeded');
    });

    it('leaves the intent open when an attempt fails, so the customer can try again', async () => {
      const { intentId, attemptId } = await createAttemptInStatus(pg.db, 'processing');

      await setAttemptStatus(pg.db, attemptId, 'failed');

      expect(await intentStatus(intentId)).toBe('open');
    });

    it('leaves the intent open for every non-success move along the way', async () => {
      const intentId = await createIntent(pg.db, await createMerchant(pg.db));
      const attemptId = await createAttempt(pg.db, intentId);

      for (const step of ['calling_processor', 'processing', 'requires_action', 'processing'] as const) {
        await setAttemptStatus(pg.db, attemptId, step);
        expect(await intentStatus(intentId)).toBe('open');
      }
    });

    it('refuses to record a success the intent cannot accept, and undoes the whole transaction', async () => {
      const { intentId, attemptId } = await createAttemptInStatus(pg.db, 'processing');

      class Rollback extends Error {}

      await pg.db
        .transaction()
        .execute(async (trx) => {
          // Reach a state the guards normally make impossible: an intent canceled underneath an
          // active attempt. (DDL is transactional, so this change vanishes on rollback.)
          await sql`alter table payment_intents disable trigger payment_intents_guard_status`.execute(trx);
          await trx.updateTable('payment_intents').set({ status: 'canceled' }).where('id', '=', intentId).execute();

          await expectSqlState(setAttemptStatus(trx, attemptId, 'succeeded'), PG.INTEGRITY, /is not open/);

          throw new Rollback();
        })
        .catch((error) => {
          if (!(error instanceof Rollback)) throw error;
        });

      // Nothing leaked out: the guard is back on and the attempt is still processing.
      const attempt = await pg.db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow();
      expect(attempt.status).toBe('processing');
      expect(await intentStatus(intentId)).toBe('open');
    });
  });

  describe('a full legal journey', () => {
    it('walks created -> calling_processor -> requires_action -> processing -> succeeded', async () => {
      const intentId = await createIntent(pg.db, await createMerchant(pg.db));
      const attemptId = await createAttempt(pg.db, intentId);

      await advanceAttemptTo(pg.db, attemptId, 'calling_processor');
      await setAttemptStatus(pg.db, attemptId, 'requires_action');
      await setAttemptStatus(pg.db, attemptId, 'processing');
      await setAttemptStatus(pg.db, attemptId, 'succeeded');

      const intent = await pg.db.selectFrom('payment_intents').select('status').where('id', '=', intentId).executeTakeFirstOrThrow();
      expect(intent.status).toBe('succeeded');
    });
  });
});

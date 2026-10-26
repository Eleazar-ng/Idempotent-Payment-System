import { attemptMachine, type AttemptStatus } from '../../payments-core/src';
import {
  createAttempt,
  createAttemptInStatus,
  createIntent,
  createMerchant,
  expectSqlState,
  PG,
  startMigratedPostgres,
  TestPostgres,
} from '../../testing/src';
import type { Kysely } from 'kysely';
import { transitionAttempt } from './attempts';
import type { TransitionOptions } from './attempts';
import type { Database } from './database.types';
import { postAttemptSuccess } from './ledger';

/**
 * transitionAttempt, except that a move to `succeeded` is booked in the same transaction, because
 * the database refuses a success without its ledger posting (migration 0006). Everything else is
 * the plain helper, so these tests still exercise exactly its behaviour.
 */
async function transition(db: Kysely<Database>, id: number, to: AttemptStatus, options: TransitionOptions) {
  if (to !== 'succeeded') return transitionAttempt(db, id, to, options);
  const run = async (conn: Kysely<Database>) => {
    const result = await transitionAttempt(conn, id, to, options);
    if (result.outcome === 'applied') await postAttemptSuccess(conn, id, { feeBps: 0 });
    return result;
  };
  return db.isTransaction ? run(db) : db.transaction().execute(run);
}

/**
 * Stage 2.3: the conditional-update helper, against a real Postgres.
 * The unit tests (attempts.spec.ts) cover what is refused before a query is sent; this file covers
 * what the database does with the query that is sent.
 */
describe('transitionAttempt (real Postgres)', () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  async function fetchAttempt(id: number) {
    return pg.db.selectFrom('payment_attempts').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  }

  async function fetchIntentStatus(id: number) {
    const row = await pg.db
      .selectFrom('payment_intents')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return row.status;
  }

  describe('applied', () => {
    it('moves the attempt and returns the updated row', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'created');
      const before = await fetchAttempt(attemptId);

      const result = await transition(pg.db, attemptId, 'calling_processor', { from: 'created' });

      expect(result.outcome).toBe('applied');
      if (result.outcome !== 'applied') throw new Error('unreachable');
      expect(result.attempt.id).toBe(attemptId);
      expect(result.attempt.status).toBe('calling_processor');
      expect(result.attempt.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
      expect((await fetchAttempt(attemptId)).status).toBe('calling_processor');
    });

    it('records the processor charge id on success, and the intent becomes succeeded with it', async () => {
      const { attemptId, intentId } = await createAttemptInStatus(pg.db, 'calling_processor');

      const result = await transition(pg.db, attemptId, 'succeeded', {
        from: 'calling_processor',
        processorChargeId: 'ch_applied_1',
      });

      expect(result.outcome).toBe('applied');
      expect((await fetchAttempt(attemptId)).processor_charge_id).toBe('ch_applied_1');
      expect(await fetchIntentStatus(intentId)).toBe('succeeded');
    });

    it('records the failure reason on failure, and leaves the intent open for a retry', async () => {
      const { attemptId, intentId } = await createAttemptInStatus(pg.db, 'processing');

      const result = await transition(pg.db, attemptId, 'failed', {
        from: 'processing',
        failureReason: 'insufficient_funds',
      });

      expect(result.outcome).toBe('applied');
      expect((await fetchAttempt(attemptId)).failure_reason).toBe('insufficient_funds');
      expect(await fetchIntentStatus(intentId)).toBe('open');
    });

    it('can record a charge id on an intermediate move, then confirm the same id on success', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');

      await transition(pg.db, attemptId, 'processing', {
        from: 'calling_processor',
        processorChargeId: 'ch_early',
      });
      const result = await transition(pg.db, attemptId, 'succeeded', {
        from: 'processing',
        processorChargeId: 'ch_early',
      });

      expect(result.outcome).toBe('applied');
      expect((await fetchAttempt(attemptId)).processor_charge_id).toBe('ch_early');
    });

    it('applies from any of several expected statuses (webhook or reconciliation arriving in any legal state)', async () => {
      for (const status of attemptMachine.legalPredecessors('succeeded')) {
        const { attemptId } = await createAttemptInStatus(pg.db, status);

        const result = await transition(pg.db, attemptId, 'succeeded', {
          from: attemptMachine.legalPredecessors('succeeded'),
          processorChargeId: `ch_any_${status}_${attemptId}`,
        });

        expect({ status, outcome: result.outcome }).toEqual({ status, outcome: 'applied' });
      }
    });
  });

  describe('already_applied: a duplicate is not an error', () => {
    it('reports it and changes nothing when the same transition arrives twice', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      const options = { from: 'calling_processor', processorChargeId: 'ch_dup' } as const;

      const first = await transition(pg.db, attemptId, 'succeeded', options);
      const afterFirst = await fetchAttempt(attemptId);
      const second = await transition(pg.db, attemptId, 'succeeded', options);
      const afterSecond = await fetchAttempt(attemptId);

      expect(first.outcome).toBe('applied');
      expect(second.outcome).toBe('already_applied');
      // Not even updated_at moved: the duplicate wrote nothing.
      expect(afterSecond).toEqual(afterFirst);
    });
  });

  describe('stale: someone else got there first', () => {
    it('refuses to fail an attempt that already succeeded (the Module 4.3 timeout-job bug)', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'succeeded');
      const before = await fetchAttempt(attemptId);

      // The timeout job read "calling_processor" a moment ago and now tries to mark it failed.
      const result = await transition(pg.db, attemptId, 'failed', {
        from: 'calling_processor',
        failureReason: 'timeout',
      });

      expect(result.outcome).toBe('stale');
      if (result.outcome !== 'stale') throw new Error('unreachable');
      expect(result.attempt.status).toBe('succeeded');
      expect(await fetchAttempt(attemptId)).toEqual(before);
    });

    it('reports the real current status so the caller can decide what to do', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'requires_action');

      const result = await transition(pg.db, attemptId, 'succeeded', {
        from: 'calling_processor',
        processorChargeId: 'ch_stale',
      });

      expect(result).toMatchObject({ outcome: 'stale', attempt: { status: 'requires_action' } });
    });

    it('does not move an attempt from a status the caller did not name, even if the move would be legal', async () => {
      // processing -> succeeded is legal, but the caller only expected calling_processor.
      const { attemptId } = await createAttemptInStatus(pg.db, 'processing');

      const result = await transition(pg.db, attemptId, 'succeeded', {
        from: 'calling_processor',
        processorChargeId: 'ch_unnamed',
      });

      expect(result.outcome).toBe('stale');
      expect((await fetchAttempt(attemptId)).status).toBe('processing');
    });
  });

  describe('not_found', () => {
    it('reports a missing attempt instead of throwing', async () => {
      const result = await transition(pg.db, 2_000_000_000, 'calling_processor', { from: 'created' });
      expect(result).toEqual({ outcome: 'not_found' });
    });
  });

  describe('races', () => {
    it('lets exactly one of many callers win when they all try the SAME move (duplicate webhook delivery)', async () => {
      const { attemptId, intentId } = await createAttemptInStatus(pg.db, 'calling_processor');

      const results = await Promise.all(
        Array.from({ length: 25 }, () =>
          transition(pg.db, attemptId, 'succeeded', {
            from: 'calling_processor',
            processorChargeId: 'ch_race_same',
          }),
        ),
      );

      const tally = (outcome: string) => results.filter((r) => r.outcome === outcome).length;
      expect(tally('applied')).toBe(1);
      expect(tally('already_applied')).toBe(24);
      expect(await fetchIntentStatus(intentId)).toBe('succeeded');
    });

    it('lets exactly one caller win when they try CONFLICTING moves (success versus failure)', async () => {
      const { attemptId, intentId } = await createAttemptInStatus(pg.db, 'calling_processor');

      // The real-world shape of 2.2: a "succeeded" response and a timeout handler's "failed"
      // racing to resolve the same attempt.
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          i % 2 === 0
            ? transition(pg.db, attemptId, 'succeeded', {
                from: 'calling_processor',
                processorChargeId: 'ch_race_conflict',
              }).then((result) => ({ target: 'succeeded', result }))
            : transition(pg.db, attemptId, 'failed', {
                from: 'calling_processor',
                failureReason: 'timeout',
              }).then((result) => ({ target: 'failed', result })),
        ),
      );

      const winners = results.filter((r) => r.result.outcome === 'applied');
      expect(winners).toHaveLength(1);

      // Every loser was told the truth: either a duplicate of the winner, or stale.
      const winningTarget = winners[0].target;
      for (const { target, result } of results) {
        if (result.outcome === 'applied') continue;
        expect(result.outcome).toBe(target === winningTarget ? 'already_applied' : 'stale');
      }

      // The database ended in exactly the state the single winner asked for, and the intent agrees.
      const final = await fetchAttempt(attemptId);
      expect(final.status).toBe(winningTarget);
      expect(await fetchIntentStatus(intentId)).toBe(winningTarget === 'succeeded' ? 'succeeded' : 'open');
    });

    it('never double-resolves across many independent attempts racing at once', async () => {
      const ids = await Promise.all(
        Array.from({ length: 10 }, async () => (await createAttemptInStatus(pg.db, 'calling_processor')).attemptId),
      );

      const results = await Promise.all(
        ids.flatMap((attemptId) => [
          transition(pg.db, attemptId, 'succeeded', {
            from: 'calling_processor',
            processorChargeId: `ch_many_${attemptId}`,
          }),
          transition(pg.db, attemptId, 'failed', { from: 'calling_processor', failureReason: 'timeout' }),
          transition(pg.db, attemptId, 'abandoned', { from: 'calling_processor' }),
        ]),
      );

      // 10 attempts, 3 contenders each: exactly 10 winners in total, one per attempt.
      expect(results.filter((r) => r.outcome === 'applied')).toHaveLength(10);
    });
  });

  describe('database protections still apply underneath', () => {
    it('refuses to change a charge id once it is set, and leaves the attempt untouched', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      await transition(pg.db, attemptId, 'processing', {
        from: 'calling_processor',
        processorChargeId: 'ch_first',
      });
      const before = await fetchAttempt(attemptId);

      await expectSqlState(
        transition(pg.db, attemptId, 'succeeded', {
          from: 'processing',
          processorChargeId: 'ch_different',
        }),
        PG.IMMUTABLE_COLUMN,
        /processor_charge_id/,
      );

      expect(await fetchAttempt(attemptId)).toEqual(before);
    });

    it('refuses a success whose charge id is already attached to another attempt', async () => {
      const first = await createAttemptInStatus(pg.db, 'calling_processor');
      const second = await createAttemptInStatus(pg.db, 'calling_processor');
      await transition(pg.db, first.attemptId, 'succeeded', {
        from: 'calling_processor',
        processorChargeId: 'ch_shared',
      });

      await expectSqlState(
        transition(pg.db, second.attemptId, 'succeeded', {
          from: 'calling_processor',
          processorChargeId: 'ch_shared',
        }),
        PG.UNIQUE_VIOLATION,
      );
      expect((await fetchAttempt(second.attemptId)).status).toBe('calling_processor');
    });

    it('refuses a success with no charge id anywhere on the row', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');

      await expectSqlState(
        transition(pg.db, attemptId, 'succeeded', { from: 'calling_processor' }),
        PG.CHECK_VIOLATION,
        /succeeded_has_charge/,
      );
    });
  });

  describe('inside a transaction', () => {
    it('is undone with the transaction, so a status change can commit or roll back together with a ledger posting', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');

      await expect(
        pg.db.transaction().execute(async (trx) => {
          const result = await transition(trx, attemptId, 'succeeded', {
            from: 'calling_processor',
            processorChargeId: 'ch_rolled_back',
          });
          expect(result.outcome).toBe('applied');
          throw new Error('simulated failure after the status change');
        }),
      ).rejects.toThrow('simulated failure');

      const after = await fetchAttempt(attemptId);
      expect(after.status).toBe('calling_processor');
      expect(after.processor_charge_id).toBeNull();
    });

    it('commits together when the transaction succeeds', async () => {
      const { attemptId, intentId } = await createAttemptInStatus(pg.db, 'calling_processor');

      await pg.db.transaction().execute(async (trx) => {
        await transition(trx, attemptId, 'succeeded', {
          from: 'calling_processor',
          processorChargeId: 'ch_committed',
        });
      });

      expect((await fetchAttempt(attemptId)).status).toBe('succeeded');
      expect(await fetchIntentStatus(intentId)).toBe('succeeded');
    });
  });

  it('carries an attempt through a whole 3-D Secure journey using the helper alone', async () => {
    const merchantId = await createMerchant(pg.db);
    const intentId = await createIntent(pg.db, merchantId);
    const attemptId = await createAttempt(pg.db, intentId);

    expect((await transition(pg.db, attemptId, 'calling_processor', { from: 'created' })).outcome).toBe(
      'applied',
    );
    expect(
      (await transition(pg.db, attemptId, 'requires_action', { from: 'calling_processor' })).outcome,
    ).toBe('applied');
    expect((await transition(pg.db, attemptId, 'processing', { from: 'requires_action' })).outcome).toBe(
      'applied',
    );
    expect(
      (
        await transition(pg.db, attemptId, 'succeeded', {
          from: 'processing',
          processorChargeId: 'ch_journey',
        })
      ).outcome,
    ).toBe('applied');

    expect(await fetchIntentStatus(intentId)).toBe('succeeded');
  });
});

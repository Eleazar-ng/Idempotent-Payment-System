import { postAttemptSuccess } from './ledger';
import {
  attemptMachine,
  intentMachine,
  isActiveAttemptStatus,
  type AttemptStatus,
  type StateMachine,
} from '../../payments-core/src';
import {
  advanceAttemptTo,
  createAttempt,
  createAttemptInStatus,
  createIntent,
  createMerchant,
  PG,
  startMigratedPostgres,
  TestPostgres,
} from '../../testing/src';

/**
 * Stage 2.2: the TypeScript state machines and the SQL tables must describe the same machine.
 *
 * There are now two enforcement layers (application code and database triggers). Two layers that
 * can quietly disagree are worse than one, so this file fails the moment they do.
 */

describe('state machines: TypeScript versus database', () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  async function dbEdges(entity: string): Promise<string[]> {
    const rows = await pg.db
      .selectFrom('status_transitions')
      .select(['from_status', 'to_status'])
      .where('entity', '=', entity)
      .execute();
    return rows.map((r) => `${r.from_status}>${r.to_status}`).sort();
  }

  const tsEdges = (machine: StateMachine<string>): string[] =>
    machine
      .edges()
      .map(([from, to]) => `${from}>${to}`)
      .sort();

  describe.each([
    ['payment_attempt', attemptMachine],
    ['payment_intent', intentMachine],
  ] as const)('%s', (entity, machine) => {
    it('has exactly the same legal moves in both places', async () => {
      expect(await dbEdges(entity)).toEqual(tsEdges(machine));
    });

    it('starts in the same initial status in both places', async () => {
      const rows = await pg.db
        .selectFrom('status_initial')
        .select('status')
        .where('entity', '=', entity)
        .execute();
      expect(rows.map((r) => r.status)).toEqual([machine.initial]);
    });

    it('knows the same set of statuses in both places', async () => {
      const rows = await pg.db
        .selectFrom('status_transitions')
        .select(['from_status', 'to_status'])
        .where('entity', '=', entity)
        .execute();
      const dbStatuses = new Set(rows.flatMap((r) => [r.from_status, r.to_status]));
      expect([...dbStatuses].sort()).toEqual([...machine.statuses].sort());
    });

    it('agrees on which statuses are terminal (no way out)', async () => {
      const rows = await pg.db
        .selectFrom('status_transitions')
        .select('from_status')
        .where('entity', '=', entity)
        .execute();
      const hasWayOut = new Set(rows.map((r) => r.from_status));
      const dbTerminal = machine.statuses.filter((s) => !hasWayOut.has(s)).sort();
      const tsTerminal = machine.statuses.filter((s) => machine.isTerminal(s)).sort();
      expect(dbTerminal).toEqual(tsTerminal);
    });
  });

  it('applies the same rule in the real triggers as in canTransition, for every attempt pair', async () => {
    // Behavioural check, not just a table comparison: ask the actual trigger about all 49 pairs
    // and require it to agree with the TypeScript answer.
    const statuses = attemptMachine.statuses;
    const mismatches: string[] = [];

    for (const from of statuses) {
      for (const to of statuses) {
        if (from === to) continue;
        const { attemptId } = await createAttemptInStatus(pg.db, from);

        let refusedByDatabase = false;
        try {
          await pg.db.transaction().execute(async (trx) => {
            await trx
              .updateTable('payment_attempts')
              .set({
                status: to,
                // Only supply what the target needs, and never a second charge id: the write-once
                // trigger fires before the transition check and would mask what we are testing.
                ...(to === 'succeeded' && from !== 'succeeded'
                  ? { processor_charge_id: `ch_${attemptId}` }
                  : {}),
                ...(to === 'failed' ? { failure_reason: 'drift_check' } : {}),
              })
              .where('id', '=', attemptId)
              .execute();
            // A legal move to succeeded only commits together with its ledger posting (0006).
            if (to === 'succeeded') await postAttemptSuccess(trx, attemptId, { feeBps: 0 });
          });
        } catch (error) {
          if ((error as { code?: string }).code !== PG.INVALID_TRANSITION) throw error;
          refusedByDatabase = true;
        }

        if (refusedByDatabase === attemptMachine.canTransition(from, to)) {
          mismatches.push(`${from} -> ${to} (database refused: ${refusedByDatabase})`);
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  describe('isActiveAttemptStatus versus the one-active-attempt-per-intent index', () => {
    // A second attempt on the same intent must be refused exactly when the first is "active".
    // The index raises 23505; for succeeded the intent-is-closed guard raises PY004 first.
    it.each(attemptMachine.statuses.map((status) => [status] as [AttemptStatus]))(
      'agrees about a first attempt in status %s',
      async (status) => {
        const merchantId = await createMerchant(pg.db);
        const intentId = await createIntent(pg.db, merchantId);
        const first = await createAttempt(pg.db, intentId, 1);
        await advanceAttemptTo(pg.db, first, status);

        let secondRefused = false;
        try {
          await createAttempt(pg.db, intentId, 2);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== PG.UNIQUE_VIOLATION && code !== PG.INTEGRITY) throw error;
          secondRefused = true;
        }

        expect(secondRefused).toBe(isActiveAttemptStatus(status));
      },
    );
  });
});

import type { Kysely } from 'kysely';
import { InvalidTransitionError, attemptMachine } from '../../payments-core/src';
import type { Database } from './database.types';
import { transitionAttempt } from './attempts';

/**
 * A database that explodes if anything touches it. Proves that bad calls are rejected BEFORE any
 * query is sent, which is the point of checking the state machine in application code too.
 */
const untouchableDb = new Proxy(
  {},
  {
    get() {
      throw new Error('the database was touched');
    },
  },
) as unknown as Kysely<Database>;

describe('transitionAttempt: checks that happen before any query', () => {
  it.each([
    ['succeeded', 'failed'],
    ['failed', 'succeeded'],
    ['created', 'succeeded'],
    ['succeeded', 'processing'],
  ] as const)('refuses the illegal move %s -> %s without touching the database', async (from, to) => {
    await expect(
      transitionAttempt(untouchableDb, 1, to, { from, failureReason: 'card_declined' }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('refuses the whole call if any one of several expected statuses is an illegal predecessor', async () => {
    await expect(
      transitionAttempt(untouchableDb, 1, 'succeeded', { from: ['calling_processor', 'failed'] }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('accepts every legal predecessor of succeeded as a group (the webhook and reconciliation case)', async () => {
    // Gets past validation and only then reaches the (exploding) database.
    await expect(
      transitionAttempt(untouchableDb, 1, 'succeeded', {
        from: attemptMachine.legalPredecessors('succeeded'),
        processorChargeId: 'ch_1',
      }),
    ).rejects.toThrow('the database was touched');
  });

  it('requires a failure reason when moving to failed', async () => {
    await expect(
      transitionAttempt(untouchableDb, 1, 'failed', { from: 'calling_processor' }),
    ).rejects.toThrow(/failureReason/);
    await expect(
      transitionAttempt(untouchableDb, 1, 'failed', { from: 'calling_processor', failureReason: '' }),
    ).rejects.toThrow(/failureReason/);
  });

  it('requires at least one expected status', async () => {
    await expect(transitionAttempt(untouchableDb, 1, 'succeeded', { from: [] })).rejects.toThrow(
      /at least one status/,
    );
  });
});

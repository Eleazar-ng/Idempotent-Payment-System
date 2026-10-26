import type { Kysely } from 'kysely';
import {
  createAttemptInStatus,
  createLedgerAccount,
  expectSqlState,
  PG,
  setAttemptStatus,
  startMigratedPostgres,
  TestPostgres,
  uid,
} from '../../testing/src';
import type { Database } from './database.types';
import { postAttemptSuccess } from './ledger';

/**
 * Migration 0006: an attempt is 'succeeded' if and only if its ledger posting exists and adds up
 * to the payment. Both sides are checked at COMMIT, so every test here runs one transaction.
 */
describe('0006 success requires posting (PY006)', () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  async function setup(amount = 5000) {
    const seeded = await createAttemptInStatus(pg.db, 'calling_processor');
    // createAttemptInStatus uses the default amount; adjust by creating an intent only when asked.
    return { ...seeded, amount };
  }

  const markSucceeded = (conn: Kysely<Database>, attemptId: number) =>
    conn
      .updateTable('payment_attempts')
      .set({ status: 'succeeded', processor_charge_id: `ch_${uid()}` })
      .where('id', '=', attemptId)
      .execute();

  /** Inserts a header + entries for an attempt success by hand, so tests can make them wrong. */
  async function rawPosting(
    conn: Kysely<Database>,
    attemptId: number,
    lines: { account: number; direction: 'debit' | 'credit'; amount: number; currency?: string }[],
    overrides: { sourceId?: number } = {},
  ) {
    const header = await conn
      .insertInto('ledger_transactions')
      .values({
        posting_key: `attempt:${attemptId}:succeeded`,
        source_type: 'payment_attempt',
        source_id: overrides.sourceId ?? attemptId,
        entry_count: lines.length,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const line of lines) {
      await conn
        .insertInto('ledger_entries')
        .values({
          transaction_id: header.id,
          account_id: line.account,
          direction: line.direction,
          amount: line.amount,
          currency: line.currency ?? 'NGN',
        })
        .execute();
    }
  }

  it('refuses a success without a posting, at commit', async () => {
    const { attemptId } = await setup();
    await expectSqlState(markSucceeded(pg.db, attemptId), PG.POSTING_MISMATCH, /without its ledger posting/);
    const row = await pg.db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow();
    expect(row.status).toBe('calling_processor');
  });

  it('commits a success together with a correct posting', async () => {
    const { attemptId } = await setup();
    await pg.db.transaction().execute(async (trx) => {
      await markSucceeded(trx, attemptId);
      await postAttemptSuccess(trx, attemptId, { feeBps: 150 });
    });
    const row = await pg.db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow();
    expect(row.status).toBe('succeeded');
  });

  it('accepts the posting being written before the status change in the same transaction', async () => {
    const { attemptId } = await setup();
    const debit = await createLedgerAccount(pg.db, 'asset');
    const credit = await createLedgerAccount(pg.db, 'liability');
    await pg.db.transaction().execute(async (trx) => {
      await rawPosting(trx, attemptId, [
        { account: debit, direction: 'debit', amount: 5000 },
        { account: credit, direction: 'credit', amount: 5000 },
      ]);
      await markSucceeded(trx, attemptId);
    });
    const row = await pg.db.selectFrom('payment_attempts').select('status').where('id', '=', attemptId).executeTakeFirstOrThrow();
    expect(row.status).toBe('succeeded');
  });

  it('refuses a posting whose debits differ from the payment amount', async () => {
    const { attemptId } = await setup();
    const debit = await createLedgerAccount(pg.db, 'asset');
    const credit = await createLedgerAccount(pg.db, 'liability');
    await expectSqlState(
      pg.db.transaction().execute(async (trx) => {
        await markSucceeded(trx, attemptId);
        await rawPosting(trx, attemptId, [
          { account: debit, direction: 'debit', amount: 4999 },
          { account: credit, direction: 'credit', amount: 4999 },
        ]);
      }),
      PG.POSTING_MISMATCH,
      /books 4999 debits/,
    );
  });

  it('refuses a posting in another currency', async () => {
    const { attemptId } = await setup();
    const debit = await createLedgerAccount(pg.db, 'asset', 'GHS');
    const credit = await createLedgerAccount(pg.db, 'liability', 'GHS');
    await expectSqlState(
      pg.db.transaction().execute(async (trx) => {
        await markSucceeded(trx, attemptId);
        await rawPosting(trx, attemptId, [
          { account: debit, direction: 'debit', amount: 5000, currency: 'GHS' },
          { account: credit, direction: 'credit', amount: 5000, currency: 'GHS' },
        ]);
      }),
      PG.POSTING_MISMATCH,
      /off-currency/,
    );
  });

  it('refuses a posting for an attempt that has not succeeded', async () => {
    const { attemptId } = await setup();
    const debit = await createLedgerAccount(pg.db, 'asset');
    const credit = await createLedgerAccount(pg.db, 'liability');
    await expectSqlState(
      pg.db.transaction().execute((trx) =>
        rawPosting(trx, attemptId, [
          { account: debit, direction: 'debit', amount: 5000 },
          { account: credit, direction: 'credit', amount: 5000 },
        ]),
      ),
      PG.POSTING_MISMATCH,
      /has not succeeded/,
    );
  });

  it('refuses a posting that points at an attempt that does not exist', async () => {
    const debit = await createLedgerAccount(pg.db, 'asset');
    const credit = await createLedgerAccount(pg.db, 'liability');
    const missing = 900_000_000 + Math.floor(Math.random() * 1000);
    await expectSqlState(
      pg.db.transaction().execute((trx) =>
        rawPosting(trx, missing, [
          { account: debit, direction: 'debit', amount: 5000 },
          { account: credit, direction: 'credit', amount: 5000 },
        ]),
      ),
      PG.POSTING_MISMATCH,
    );
  });

  it('refuses a posting keyed to one attempt but pointing at another', async () => {
    const a = await setup();
    const b = await setup();
    const debit = await createLedgerAccount(pg.db, 'asset');
    const credit = await createLedgerAccount(pg.db, 'liability');
    await expectSqlState(
      pg.db.transaction().execute(async (trx) => {
        await markSucceeded(trx, a.attemptId);
        await rawPosting(
          trx,
          a.attemptId,
          [
            { account: debit, direction: 'debit', amount: 5000 },
            { account: credit, direction: 'credit', amount: 5000 },
          ],
          { sourceId: b.attemptId },
        );
      }),
      PG.POSTING_MISMATCH,
    );
  });

  it('does not re-check an attempt that was already succeeded (only the move into it)', async () => {
    const { attemptId } = await createAttemptInStatus(pg.db, 'succeeded');
    // Touching other columns of a succeeded attempt must not demand a second posting.
    await pg.db.updateTable('payment_attempts').set({ updated_at: new Date() }).where('id', '=', attemptId).execute();
  });

  it('keeps the seed helper honest: setAttemptStatus books the success', async () => {
    const { attemptId } = await setup();
    await setAttemptStatus(pg.db, attemptId, 'succeeded');
    const t = await pg.db
      .selectFrom('ledger_transactions')
      .select('id')
      .where('posting_key', '=', `attempt:${attemptId}:succeeded`)
      .executeTakeFirst();
    expect(t).toBeDefined();
  });
});

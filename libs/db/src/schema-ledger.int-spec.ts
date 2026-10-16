import { sql } from 'kysely';
import {
  createLedgerAccount,
  expectSqlState,
  PG,
  postLedgerTransaction,
  startMigratedPostgres,
  TestPostgres,
  uid,
} from '../../testing/src';

/** Stage 1.4: an append-only, balanced, de-duplicated ledger, enforced by the database. */
describe('schema: ledger (0004)', () => {
  let pg: TestPostgres;
  let receivable: number; // asset
  let merchantBalance: number; // liability
  let platformFees: number; // revenue
  let usdReceivable: number;
  let usdMerchantBalance: number;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    receivable = await createLedgerAccount(pg.db, 'asset', 'NGN');
    merchantBalance = await createLedgerAccount(pg.db, 'liability', 'NGN');
    platformFees = await createLedgerAccount(pg.db, 'revenue', 'NGN');
    usdReceivable = await createLedgerAccount(pg.db, 'asset', 'USD');
    usdMerchantBalance = await createLedgerAccount(pg.db, 'liability', 'USD');
  });

  afterAll(async () => {
    await pg?.stop();
  });

  const key = (label: string) => `payment_attempt:${label}-${uid()}:capture`;

  /** The posting from Module 8.2: a 5,000 card payment split into merchant balance and a fee. */
  const capture = (postingKey: string) =>
    postLedgerTransaction(pg.db, postingKey, [
      { accountId: receivable, direction: 'debit', amount: 5000 },
      { accountId: merchantBalance, direction: 'credit', amount: 4850 },
      { accountId: platformFees, direction: 'credit', amount: 150 },
    ]);

  const transactionCount = async (postingKey: string) => {
    const { rows } = await sql<{ n: number }>`select count(*) as n from ledger_transactions where posting_key = ${postingKey}`.execute(pg.db);
    return rows[0].n;
  };

  const entryCount = async (postingKey: string) => {
    const { rows } = await sql<{ n: number }>`
      select count(*) as n from ledger_entries e
      join ledger_transactions t on t.id = e.transaction_id
      where t.posting_key = ${postingKey}`.execute(pg.db);
    return rows[0].n;
  };

  describe('balanced postings', () => {
    it('commits a balanced three-legged posting', async () => {
      const postingKey = key('ok');

      expect(await capture(postingKey)).toBe(true);

      expect(await transactionCount(postingKey)).toBe(1);
      expect(await entryCount(postingKey)).toBe(3);
    });

    it('derives balances from the entries', async () => {
      const a = await createLedgerAccount(pg.db, 'asset');
      const l = await createLedgerAccount(pg.db, 'liability');
      await postLedgerTransaction(pg.db, key('bal1'), [
        { accountId: a, direction: 'debit', amount: 1000 },
        { accountId: l, direction: 'credit', amount: 1000 },
      ]);
      await postLedgerTransaction(pg.db, key('bal2'), [
        { accountId: a, direction: 'debit', amount: 250 },
        { accountId: l, direction: 'credit', amount: 250 },
      ]);

      const { rows } = await sql<{ account_id: number; net_debit: number }>`
        select account_id, net_debit from ledger_account_balances where account_id in (${a}, ${l})`.execute(pg.db);

      expect(rows.find((r) => r.account_id === a)?.net_debit).toBe(1250);
      expect(rows.find((r) => r.account_id === l)?.net_debit).toBe(-1250);
    });

    it('reports a zero balance for an account with no entries', async () => {
      const empty = await createLedgerAccount(pg.db, 'asset');

      const { rows } = await sql<{ net_debit: number }>`select net_debit from ledger_account_balances where account_id = ${empty}`.execute(pg.db);

      expect(rows[0].net_debit).toBe(0);
    });

    it('balances to zero across the whole ledger, always', async () => {
      await capture(key('sum1'));
      await capture(key('sum2'));

      const { rows } = await sql<{ total: number }>`select coalesce(sum(net_debit), 0)::bigint as total from ledger_account_balances`.execute(pg.db);

      expect(rows[0].total).toBe(0);
    });
  });

  describe('unbalanced postings are refused at commit, and leave nothing behind', () => {
    it('rejects debits that exceed credits', async () => {
      const postingKey = key('unbalanced');

      await expectSqlState(
        postLedgerTransaction(pg.db, postingKey, [
          { accountId: receivable, direction: 'debit', amount: 5000 },
          { accountId: merchantBalance, direction: 'credit', amount: 4850 },
        ]),
        PG.UNBALANCED_LEDGER,
        /does not balance in NGN/,
      );

      expect(await transactionCount(postingKey)).toBe(0);
      expect(await entryCount(postingKey)).toBe(0);
    });

    it('rejects a posting that is balanced only by accident of mixing currencies', async () => {
      // 5000 NGN debit "balanced" by a 5000 USD credit is not balanced in either currency.
      await expectSqlState(
        postLedgerTransaction(pg.db, key('mixed'), [
          { accountId: receivable, direction: 'debit', amount: 5000, currency: 'NGN' },
          { accountId: usdMerchantBalance, direction: 'credit', amount: 5000, currency: 'USD' },
        ]),
        PG.UNBALANCED_LEDGER,
      );
    });

    it('accepts one transaction that balances separately in each currency', async () => {
      const postingKey = key('two-currencies');

      await postLedgerTransaction(pg.db, postingKey, [
        { accountId: receivable, direction: 'debit', amount: 5000, currency: 'NGN' },
        { accountId: merchantBalance, direction: 'credit', amount: 5000, currency: 'NGN' },
        { accountId: usdReceivable, direction: 'debit', amount: 10, currency: 'USD' },
        { accountId: usdMerchantBalance, direction: 'credit', amount: 10, currency: 'USD' },
      ]);

      expect(await entryCount(postingKey)).toBe(4);
    });

    it('rejects a transaction header that has no entries at all', async () => {
      const postingKey = key('empty');

      await expectSqlState(postLedgerTransaction(pg.db, postingKey, [], { entryCount: 2 }), PG.UNBALANCED_LEDGER, /has 0 entries but declares 2/);

      expect(await transactionCount(postingKey)).toBe(0);
    });

    it('rejects a single entry, which can never balance', async () => {
      await expectSqlState(
        postLedgerTransaction(pg.db, key('single'), [{ accountId: receivable, direction: 'debit', amount: 100 }], { entryCount: 2 }),
        PG.UNBALANCED_LEDGER,
      );
    });

    it('rejects a posting whose entries do not match the count it declared', async () => {
      await expectSqlState(
        postLedgerTransaction(
          pg.db,
          key('miscount'),
          [
            { accountId: receivable, direction: 'debit', amount: 100 },
            { accountId: merchantBalance, direction: 'credit', amount: 100 },
          ],
          { entryCount: 3 },
        ),
        PG.UNBALANCED_LEDGER,
        /has 2 entries but declares 3/,
      );
    });

    it('rejects a declared entry count below two', async () => {
      await expectSqlState(
        postLedgerTransaction(pg.db, key('count-one'), [], { entryCount: 1 }),
        PG.CHECK_VIOLATION,
      );
    });
  });

  describe('sealed transactions', () => {
    it('refuses entries added to an existing transaction later, even a balanced pair', async () => {
      const postingKey = key('sealed');
      await capture(postingKey);
      const { rows } = await sql<{ id: number }>`select id from ledger_transactions where posting_key = ${postingKey}`.execute(pg.db);
      const transactionId = rows[0].id;

      // A "harmless" balanced pair added in a later transaction would still rewrite history.
      await expectSqlState(
        pg.db.transaction().execute(async (trx) => {
          await trx.insertInto('ledger_entries').values({ transaction_id: transactionId, account_id: receivable, direction: 'debit', amount: 1, currency: 'NGN' }).execute();
          await trx.insertInto('ledger_entries').values({ transaction_id: transactionId, account_id: merchantBalance, direction: 'credit', amount: 1, currency: 'NGN' }).execute();
        }),
        PG.UNBALANCED_LEDGER,
        /has 5 entries but declares 3/,
      );

      expect(await entryCount(postingKey)).toBe(3);
    });
  });

  describe('entry validity', () => {
    it('refuses an entry in a different currency than its account', async () => {
      await expectSqlState(
        postLedgerTransaction(pg.db, key('wrong-currency'), [
          { accountId: receivable, direction: 'debit', amount: 100, currency: 'USD' }, // account is NGN
          { accountId: usdMerchantBalance, direction: 'credit', amount: 100, currency: 'USD' },
        ]),
        PG.FOREIGN_KEY_VIOLATION,
        /ledger_entries_account_currency/,
      );
    });

    it('refuses an entry for an account that does not exist', async () => {
      await expectSqlState(
        postLedgerTransaction(pg.db, key('no-account'), [
          { accountId: 999_999_999, direction: 'debit', amount: 100 },
          { accountId: merchantBalance, direction: 'credit', amount: 100 },
        ]),
        PG.FOREIGN_KEY_VIOLATION,
      );
    });

    it.each([0, -100])('refuses a non-positive amount (%d)', async (amount) => {
      await expectSqlState(
        postLedgerTransaction(pg.db, key('bad-amount'), [
          { accountId: receivable, direction: 'debit', amount },
          { accountId: merchantBalance, direction: 'credit', amount: 100 },
        ]),
        PG.CHECK_VIOLATION,
      );
    });

    it('refuses an unknown direction', async () => {
      await expectSqlState(
        postLedgerTransaction(pg.db, key('bad-direction'), [
          { accountId: receivable, direction: 'sideways' as never, amount: 100 },
          { accountId: merchantBalance, direction: 'credit', amount: 100 },
        ]),
        PG.CHECK_VIOLATION,
      );
    });

    it('refuses an unknown source type', async () => {
      await expectSqlState(
        pg.db
          .insertInto('ledger_transactions')
          .values({ posting_key: key('bad-source'), source_type: 'gift' as never, source_id: 1, entry_count: 2 })
          .execute(),
        PG.CHECK_VIOLATION,
      );
    });
  });

  describe('one posting per business event (Module 8.4)', () => {
    it('treats a repeat of the same posting key as a no-op, not an error', async () => {
      const postingKey = key('repeat');

      const first = await capture(postingKey);
      const second = await capture(postingKey);

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(await transactionCount(postingKey)).toBe(1);
      expect(await entryCount(postingKey)).toBe(3); // not 6
    });

    it('enforces the posting key with a unique constraint when ON CONFLICT is not used', async () => {
      const postingKey = key('unique');
      await capture(postingKey);

      await expectSqlState(
        pg.db
          .insertInto('ledger_transactions')
          .values({ posting_key: postingKey, source_type: 'payment_attempt', source_id: 1, entry_count: 2 })
          .execute(),
        PG.UNIQUE_VIOLATION,
        /ledger_transactions_posting_key/,
      );
    });

    it('records money exactly once when the API, a webhook and reconciliation all report the same event', async () => {
      const postingKey = key('converge');

      // Ten code paths learn about the same captured payment at the same instant.
      const posted = await Promise.all(Array.from({ length: 10 }, () => capture(postingKey)));

      expect(posted.filter(Boolean)).toHaveLength(1);
      expect(await transactionCount(postingKey)).toBe(1);
      expect(await entryCount(postingKey)).toBe(3);
    });
  });

  describe('append-only', () => {
    let postingKey: string;

    beforeAll(async () => {
      postingKey = key('immutable');
      await capture(postingKey);
    });

    it('refuses to change an entry', async () => {
      await expectSqlState(
        sql`update ledger_entries set amount = 1 where transaction_id = (select id from ledger_transactions where posting_key = ${postingKey})`.execute(pg.db),
        PG.APPEND_ONLY,
      );
    });

    it('refuses to delete an entry', async () => {
      await expectSqlState(
        sql`delete from ledger_entries where transaction_id = (select id from ledger_transactions where posting_key = ${postingKey})`.execute(pg.db),
        PG.APPEND_ONLY,
      );
    });

    it('refuses to change or delete a transaction', async () => {
      await expectSqlState(
        sql`update ledger_transactions set source_id = 2 where posting_key = ${postingKey}`.execute(pg.db),
        PG.APPEND_ONLY,
      );
      await expectSqlState(
        sql`delete from ledger_transactions where posting_key = ${postingKey}`.execute(pg.db),
        PG.APPEND_ONLY,
      );
    });

    it('refuses TRUNCATE on both tables', async () => {
      await expectSqlState(sql`truncate ledger_entries`.execute(pg.db), PG.APPEND_ONLY);
      await expectSqlState(sql`truncate ledger_transactions cascade`.execute(pg.db), PG.APPEND_ONLY);
    });

    it('refuses to rewrite or remove an account', async () => {
      await expectSqlState(sql`update ledger_accounts set currency = 'USD' where id = ${receivable}`.execute(pg.db), PG.APPEND_ONLY);
      await expectSqlState(sql`delete from ledger_accounts where id = ${platformFees}`.execute(pg.db), PG.APPEND_ONLY);
    });

    it('corrects a mistake with a reversing transaction instead, preserving the audit trail', async () => {
      const original = key('mistake');
      const reversal = `reversal:${original}`;
      await capture(original);

      await postLedgerTransaction(pg.db, reversal, [
        { accountId: receivable, direction: 'credit', amount: 5000 },
        { accountId: merchantBalance, direction: 'debit', amount: 4850 },
        { accountId: platformFees, direction: 'debit', amount: 150 },
      ]);

      expect(await transactionCount(original)).toBe(1); // history intact
      expect(await transactionCount(reversal)).toBe(1);
      const { rows } = await sql<{ net: number }>`
        select coalesce(sum(case e.direction when 'debit' then e.amount else -e.amount end), 0)::bigint as net
        from ledger_entries e join ledger_transactions t on t.id = e.transaction_id
        where t.posting_key in (${original}, ${reversal}) and e.account_id = ${receivable}`.execute(pg.db);
      expect(rows[0].net).toBe(0);
    });
  });

  describe('accounts', () => {
    it('require a unique code', async () => {
      const code = `code-${uid()}`;
      await createLedgerAccount(pg.db, 'asset', 'NGN', code);

      await expectSqlState(createLedgerAccount(pg.db, 'asset', 'NGN', code), PG.UNIQUE_VIOLATION);
    });

    it('require a known kind and a well-formed currency', async () => {
      await expectSqlState(createLedgerAccount(pg.db, 'wishful' as never), PG.CHECK_VIOLATION);
      await expectSqlState(createLedgerAccount(pg.db, 'asset', 'ngn'), PG.CHECK_VIOLATION);
    });
  });
});

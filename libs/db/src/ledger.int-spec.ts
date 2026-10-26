import { buildAttemptSuccessPosting, merchantPayableAccount } from '../../payments-core/src';
import type { ProcessorOutcome } from '../../payments-core/src';
import {
  createAttemptInStatus,
  createIntent,
  createLedgerAccount,
  createMerchant,
  startMigratedPostgres,
  TestPostgres,
  uid,
} from '../../testing/src';
import { sql } from 'kysely';
import { checkLedgerInvariants } from './invariants';
import { applyProcessorOutcome } from './payments';
import {
  ensureAccount,
  getMerchantBalances,
  LedgerAccountMismatchError,
  postAttemptSuccess,
  postLedger,
} from './ledger';

describe('ledger posting (real Postgres)', () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  const succeed = (attemptId: number, feeBps: number) =>
    pg.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('payment_attempts')
        .set({ status: 'succeeded', processor_charge_id: `ch_${uid()}` })
        .where('id', '=', attemptId)
        .execute();
      return postAttemptSuccess(trx, attemptId, { feeBps });
    });

  const entriesOf = async (attemptId: number) => {
    const rows = await sql<{ code: string; direction: string; amount: number }>`
      SELECT a.code, e.direction, e.amount::bigint AS amount
      FROM ledger_transactions t
      JOIN ledger_entries e ON e.transaction_id = t.id
      JOIN ledger_accounts a ON a.id = e.account_id
      WHERE t.posting_key = ${`attempt:${attemptId}:succeeded`}
      ORDER BY a.code`.execute(pg.db);
    return rows.rows.map((r) => ({ ...r, amount: Number(r.amount) }));
  };

  describe('ensureAccount', () => {
    it('creates on first use and returns the same id afterwards', async () => {
      const spec = { code: `acct-${uid()}`, kind: 'asset', currency: 'NGN' } as const;
      const a = await ensureAccount(pg.db, spec);
      const b = await ensureAccount(pg.db, spec);
      expect(b).toBe(a);
    });

    it('is safe when many callers race to create the same account', async () => {
      const spec = { code: `acct-${uid()}`, kind: 'liability', currency: 'NGN' } as const;
      const ids = await Promise.all(Array.from({ length: 10 }, () => ensureAccount(pg.db, spec)));
      expect(new Set(ids).size).toBe(1);
    });

    it('refuses an existing account that is a different kind or currency', async () => {
      const code = `acct-${uid()}`;
      await createLedgerAccount(pg.db, 'expense', 'GHS', code);
      await expect(ensureAccount(pg.db, { code, kind: 'asset', currency: 'GHS' })).rejects.toBeInstanceOf(
        LedgerAccountMismatchError,
      );
      await expect(ensureAccount(pg.db, { code, kind: 'expense', currency: 'NGN' })).rejects.toBeInstanceOf(
        LedgerAccountMismatchError,
      );
    });
  });

  describe('postAttemptSuccess', () => {
    it('books receivable, payable and fee for a 150 bps fee', async () => {
      const { attemptId, merchantId } = await createAttemptInStatus(pg.db, 'calling_processor');
      const result = await succeed(attemptId, 150);
      expect(result.outcome).toBe('posted');
      expect(await entriesOf(attemptId)).toEqual([
        { code: `merchant_payable:${merchantId}:NGN`, direction: 'credit', amount: 4925 },
        { code: 'platform_fee_revenue:NGN', direction: 'credit', amount: 75 },
        { code: 'processor_receivable:NGN', direction: 'debit', amount: 5000 },
      ]);
    });

    it('omits the fee line when the fee is zero', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      await succeed(attemptId, 0);
      expect((await entriesOf(attemptId)).map((e) => e.direction)).toEqual(['credit', 'debit']);
    });

    it('is a no-op the second time, and reports whether the books agree', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      const first = await succeed(attemptId, 150);
      const again = await postAttemptSuccess(pg.db, attemptId, { feeBps: 150 });
      expect(again).toMatchObject({ outcome: 'already_posted', identical: true });
      expect(again.transactionId).toBe(first.transactionId);

      const changedFee = await postAttemptSuccess(pg.db, attemptId, { feeBps: 300 });
      expect(changedFee).toMatchObject({ outcome: 'already_posted', identical: false });
      expect(await entriesOf(attemptId)).toHaveLength(3); // nothing was added
    });

    it('books exactly once when many callers race', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      await pg.db
        .updateTable('payment_attempts')
        .set({ status: 'succeeded', processor_charge_id: `ch_${uid()}` })
        .where('id', '=', attemptId)
        .execute()
        .catch(() => undefined); // refused at commit: no posting yet, so still calling_processor
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          pg.db.transaction().execute(async (trx) => {
            await trx
              .updateTable('payment_attempts')
              .set({ status: 'succeeded', processor_charge_id: `ch_${attemptId}` })
              .where('id', '=', attemptId)
              .where('status', '=', 'calling_processor')
              .execute();
            return postAttemptSuccess(trx, attemptId, { feeBps: 150 }).catch((e: Error) => e);
          }),
        ),
      );
      // however the race fell out, the books hold the posting exactly once
      expect(await entriesOf(attemptId)).toHaveLength(3);
      expect(results.some((r) => !(r instanceof Error) && r.outcome === 'posted')).toBe(true);
    });

    it('refuses to book an attempt that has not succeeded', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      await expect(postAttemptSuccess(pg.db, attemptId, { feeBps: 0 })).rejects.toThrow(/only succeeded attempts/);
    });

    it('refuses an attempt that does not exist', async () => {
      await expect(postAttemptSuccess(pg.db, 987_654_321, { feeBps: 0 })).rejects.toThrow(/no attempt/);
    });
  });

  describe('postLedger', () => {
    it('refuses an unbalanced posting in code, before any query is sent', async () => {
      const posting = buildAttemptSuccessPosting({ attemptId: 1, merchantId: 1, amount: 100, currency: 'NGN', feeBps: 0 });
      const broken = { ...posting, entries: posting.entries.map((e, i) => (i === 0 ? { ...e, amount: e.amount + 1 } : e)) };
      await expect(postLedger(pg.db, broken)).rejects.toThrow(/does not balance/);
    });
  });

  describe('getMerchantBalances', () => {
    it('sums what we owe the merchant per currency and ignores other merchants', async () => {
      const merchantId = await createMerchant(pg.db);
      const other = await createMerchant(pg.db);
      for (const [m, currency, amount] of [
        [merchantId, 'NGN', 5000],
        [merchantId, 'NGN', 2000],
        [merchantId, 'GHS', 1000],
        [other, 'NGN', 9000],
      ] as const) {
        const intentId = await createIntent(pg.db, m, { amount, currency });
        const attempt = await pg.db
          .insertInto('payment_attempts')
          .values({
            payment_intent_id: intentId,
            attempt_number: 1,
            processor_idempotency_key: `pi_${intentId}_a1_${uid()}`,
            payment_source: 'tok_test',
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await pg.db.updateTable('payment_attempts').set({ status: 'calling_processor' }).where('id', '=', attempt.id).execute();
        await succeed(attempt.id, 100);
      }
      expect(await getMerchantBalances(pg.db, merchantId)).toEqual([
        { currency: 'GHS', payable: 990 },
        { currency: 'NGN', payable: 6930 },
      ]);
      expect(merchantPayableAccount(merchantId, 'NGN').code).toBe(`merchant_payable:${merchantId}:NGN`);
    });

    it('is empty for a merchant with no postings', async () => {
      expect(await getMerchantBalances(pg.db, await createMerchant(pg.db))).toEqual([]);
    });

    it('does not mix up merchant 1 with merchant 12', async () => {
      // "merchant_payable:1:" must not match "merchant_payable:12:"
      const m12 = await createMerchant(pg.db);
      expect(await getMerchantBalances(pg.db, m12)).toEqual([]);
    });
  });

  describe('applyProcessorOutcome books the success in the same transaction', () => {
    it('posts on success', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      const r = await applyProcessorOutcome(
        pg.db,
        attemptId,
        { kind: 'succeeded', chargeId: `ch_${uid()}` },
        'calling_processor',
        { feeBps: 150 },
      );
      expect(r.outcome).toBe('applied');
      expect(await entriesOf(attemptId)).toHaveLength(3);
    });

    it('is a no-op on the second delivery', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      const chargeId = `ch_${uid()}`;
      const outcome = { kind: 'succeeded', chargeId } as const;
      await applyProcessorOutcome(pg.db, attemptId, outcome, ['calling_processor', 'processing'], { feeBps: 150 });
      const again = await applyProcessorOutcome(pg.db, attemptId, outcome, ['calling_processor', 'processing'], { feeBps: 150 });
      expect(again.outcome).toBe('already_applied');
      expect(await entriesOf(attemptId)).toHaveLength(3);
    });

    it('leaves nothing behind when booking fails: the status change rolls back too', async () => {
      const { attemptId, merchantId } = await createAttemptInStatus(pg.db, 'calling_processor');
      // A same-coded account of the wrong kind makes booking impossible.
      await createLedgerAccount(pg.db, 'expense', 'NGN', merchantPayableAccount(merchantId, 'NGN').code);
      await expect(
        applyProcessorOutcome(pg.db, attemptId, { kind: 'succeeded', chargeId: `ch_${uid()}` }, 'calling_processor', {
          feeBps: 150,
        }),
      ).rejects.toBeInstanceOf(LedgerAccountMismatchError);
      const row = await pg.db
        .selectFrom('payment_attempts')
        .select(['status', 'processor_charge_id'])
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ status: 'calling_processor', processor_charge_id: null });
      expect(await entriesOf(attemptId)).toHaveLength(0);
    });

    it('repairs a success that was somehow left unbooked, when the same outcome arrives again', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      const chargeId = `ch_${uid()}`;
      await pg.db.transaction().execute(async (trx) => {
        await sql`ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_success_needs_posting`.execute(trx);
        await trx
          .updateTable('payment_attempts')
          .set({ status: 'succeeded', processor_charge_id: chargeId })
          .where('id', '=', attemptId)
          .execute();
        await sql`ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_success_needs_posting`.execute(trx);
      });
      expect(await entriesOf(attemptId)).toHaveLength(0);

      const r = await applyProcessorOutcome(pg.db, attemptId, { kind: 'succeeded', chargeId }, ['calling_processor', 'processing'], { feeBps: 150 });
      expect(r.outcome).toBe('already_applied');
      expect(await entriesOf(attemptId)).toHaveLength(3);
    });

    it.each<[string, ProcessorOutcome]>([
      ['declined', { kind: 'declined', code: 'card_declined' }],
      ['requires_action', { kind: 'requires_action', chargeId: 'ch_ra' }],
      ['processing', { kind: 'processing', chargeId: 'ch_pr' }],
      ['unknown', { kind: 'unknown', reason: 'timeout' }],
    ])('books nothing for %s', async (_name, outcome) => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      const unique =
        outcome.kind === 'requires_action' || outcome.kind === 'processing'
          ? { ...outcome, chargeId: `ch_${uid()}` }
          : outcome;
      await applyProcessorOutcome(pg.db, attemptId, unique, 'calling_processor', { feeBps: 150 });
      expect(await entriesOf(attemptId)).toHaveLength(0);
    });
  });

  describe('checkLedgerInvariants', () => {
    it('is empty for a healthy book', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      await succeed(attemptId, 150);
      expect(await checkLedgerInvariants(pg.db)).toEqual([]);
    });

    it('notices a success with no posting, once the database guard is bypassed', async () => {
      const { attemptId } = await createAttemptInStatus(pg.db, 'calling_processor');
      await pg.db.transaction().execute(async (trx) => {
        await sql`ALTER TABLE payment_attempts DISABLE TRIGGER payment_attempts_success_needs_posting`.execute(trx);
        await trx
          .updateTable('payment_attempts')
          .set({ status: 'succeeded', processor_charge_id: `ch_${uid()}` })
          .where('id', '=', attemptId)
          .execute();
        await sql`ALTER TABLE payment_attempts ENABLE TRIGGER payment_attempts_success_needs_posting`.execute(trx);
      });
      const found = await checkLedgerInvariants(pg.db);
      expect(found).toContainEqual(expect.objectContaining({ invariant: 'succeeded_attempt_has_posting' }));
      expect(found.find((v) => v.detail.includes(`attempt ${attemptId} `))).toBeDefined();
      // repair, so later suites in this file see a healthy book
      await pg.db.transaction().execute((trx) => postAttemptSuccess(trx, attemptId, { feeBps: 0 }));
      expect(await checkLedgerInvariants(pg.db)).toEqual([]);
    });
  });
});

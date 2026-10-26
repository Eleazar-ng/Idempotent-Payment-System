import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { assertBalanced, buildAttemptSuccessPosting } from '../../payments-core/src';
import type { AccountSpec, Posting } from '../../payments-core/src';
import type { Database } from './database.types';

/** An account with this code exists but is not the kind or currency the code promises. */
export class LedgerAccountMismatchError extends Error {
  readonly code = 'LEDGER_ACCOUNT_MISMATCH';

  constructor(
    readonly account: AccountSpec,
    readonly found: { kind: string; currency: string },
  ) {
    super(
      `ledger account ${account.code} exists as ${found.kind}/${found.currency}, expected ${account.kind}/${account.currency}`,
    );
    this.name = 'LedgerAccountMismatchError';
  }
}

/**
 * Returns the id of the account with this code, creating it on first use. Accounts are created
 * lazily (one payable account per merchant and currency, say) with the same atomic-claim pattern
 * used everywhere else: INSERT ... ON CONFLICT DO NOTHING, then read.
 */
export async function ensureAccount(db: Kysely<Database>, spec: AccountSpec): Promise<number> {
  const created = await db
    .insertInto('ledger_accounts')
    .values({ code: spec.code, kind: spec.kind, currency: spec.currency })
    .onConflict((oc) => oc.column('code').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (created) return created.id;

  const existing = await db
    .selectFrom('ledger_accounts')
    .select(['id', 'kind', 'currency'])
    .where('code', '=', spec.code)
    .executeTakeFirstOrThrow(); // accounts can never be deleted, so it must be there
  if (existing.kind !== spec.kind || existing.currency !== spec.currency) {
    throw new LedgerAccountMismatchError(spec, existing);
  }
  return existing.id;
}

export type PostResult =
  /** This call wrote the entries. */
  | { outcome: 'posted'; transactionId: number }
  /**
   * The posting key was already used, so nothing was written (Module 8.4: the second path is a
   * no-op). `identical` says whether what is booked equals what this call would have booked; false
   * means the two paths disagree (for example the fee setting changed in between) and is worth a log.
   */
  | { outcome: 'already_posted'; transactionId: number; identical: boolean };

/**
 * Writes one balanced posting: the header and all its entries, under a unique posting key.
 *
 * It must run inside the same transaction as whatever caused it. The database enforces the pairing
 * (migration 0006), so calling it in a separate transaction is not just wrong, it fails.
 */
export async function postLedger(db: Kysely<Database>, posting: Posting): Promise<PostResult> {
  assertBalanced(posting);

  // Create accounts in a fixed order. Two transactions creating the same pair of accounts in
  // opposite orders would deadlock; sorted by code, they queue instead.
  const specs = new Map<string, AccountSpec>();
  for (const { account } of posting.entries) specs.set(account.code, account);
  const ids = new Map<string, number>();
  for (const spec of [...specs.values()].sort((a, b) => a.code.localeCompare(b.code))) {
    ids.set(spec.code, await ensureAccount(db, spec));
  }

  const header = await db
    .insertInto('ledger_transactions')
    .values({
      posting_key: posting.postingKey,
      source_type: posting.sourceType,
      source_id: posting.sourceId,
      entry_count: posting.entries.length,
    })
    .onConflict((oc) => oc.column('posting_key').doNothing())
    .returning('id')
    .executeTakeFirst();

  if (!header) {
    return alreadyPosted(db, posting, ids);
  }

  await db
    .insertInto('ledger_entries')
    .values(
      posting.entries.map((entry) => ({
        transaction_id: header.id,
        account_id: ids.get(entry.account.code) as number,
        direction: entry.direction,
        amount: entry.amount,
        currency: entry.account.currency,
      })),
    )
    .execute();

  return { outcome: 'posted', transactionId: header.id };
}

async function alreadyPosted(db: Kysely<Database>, posting: Posting, ids: Map<string, number>): Promise<PostResult> {
  const existing = await db
    .selectFrom('ledger_transactions')
    .select(['id', 'source_type', 'source_id'])
    .where('posting_key', '=', posting.postingKey)
    .executeTakeFirstOrThrow();
  const entries = await db
    .selectFrom('ledger_entries')
    .select(['account_id', 'direction', 'amount'])
    .where('transaction_id', '=', existing.id)
    .execute();

  const describe = (e: { account_id: number; direction: string; amount: number }) =>
    `${e.account_id}:${e.direction}:${e.amount}`;
  const booked = entries.map(describe).sort();
  const wanted = posting.entries
    .map((e) => describe({ account_id: ids.get(e.account.code) as number, direction: e.direction, amount: e.amount }))
    .sort();
  const identical =
    existing.source_type === posting.sourceType &&
    existing.source_id === posting.sourceId &&
    booked.length === wanted.length &&
    booked.every((line, i) => line === wanted[i]);

  return { outcome: 'already_posted', transactionId: existing.id, identical };
}

/**
 * Books the success of an attempt that has just been moved to `succeeded` in THIS transaction.
 * Reads the amount, currency and merchant from the database, never from the caller, so the books
 * can only ever say what the payment really was.
 */
export async function postAttemptSuccess(
  db: Kysely<Database>,
  attemptId: number,
  options: { feeBps: number },
): Promise<PostResult> {
  const row = await db
    .selectFrom('payment_attempts as a')
    .innerJoin('payment_intents as i', 'i.id', 'a.payment_intent_id')
    .select(['a.status', 'i.merchant_id', 'i.amount', 'i.currency'])
    .where('a.id', '=', attemptId)
    .executeTakeFirst();
  if (!row) throw new Error(`postAttemptSuccess: no attempt ${attemptId}`);
  if (row.status !== 'succeeded') {
    throw new Error(`postAttemptSuccess: attempt ${attemptId} is "${row.status}", only succeeded attempts are booked`);
  }
  return postLedger(
    db,
    buildAttemptSuccessPosting({
      attemptId,
      merchantId: row.merchant_id,
      amount: row.amount,
      currency: row.currency,
      feeBps: options.feeBps,
    }),
  );
}

export interface MerchantBalance {
  currency: string;
  /** What we owe the merchant, in minor units: the credit balance of their payable account. */
  payable: number;
}

export async function getMerchantBalances(db: Kysely<Database>, merchantId: number): Promise<MerchantBalance[]> {
  const prefix = `merchant_payable:${merchantId}:`;
  const rows = await db
    .selectFrom('ledger_account_balances')
    .select(['currency', 'net_debit'])
    .where(sql<boolean>`starts_with(code, ${prefix})`)
    .orderBy('currency')
    .execute();
  // Liabilities carry credit balances, which the view reports as negative net debit.
  return rows.map((r) => ({ currency: r.currency, payable: -r.net_debit }));
}

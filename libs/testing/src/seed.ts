import { randomBytes } from 'node:crypto';
import { Kysely, sql } from 'kysely';
import type { Database, PaymentAttemptStatus } from '../../db/src';

/** Short random suffix so tests never collide on unique business keys. */
export function uid(): string {
  return randomBytes(5).toString('hex');
}

export async function createMerchant(db: Kysely<Database>, name = `merchant-${uid()}`): Promise<number> {
  const row = await db.insertInto('merchants').values({ name }).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

export async function createIntent(
  db: Kysely<Database>,
  merchantId: number,
  overrides: { orderId?: string; amount?: number; currency?: string } = {},
): Promise<number> {
  const row = await db
    .insertInto('payment_intents')
    .values({
      merchant_id: merchantId,
      order_id: overrides.orderId ?? `order-${uid()}`,
      amount: overrides.amount ?? 5000,
      currency: overrides.currency ?? 'NGN',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function createAttempt(
  db: Kysely<Database>,
  intentId: number,
  attemptNumber = 1,
): Promise<number> {
  const row = await db
    .insertInto('payment_attempts')
    .values({
      payment_intent_id: intentId,
      attempt_number: attemptNumber,
      // Derived from the intent id (globally unique), as the 0001 migration recommends.
      processor_idempotency_key: `pi_${intentId}_a${attemptNumber}_${uid()}`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Moves an attempt to `status`, supplying the charge id or failure reason those states require. */
export async function setAttemptStatus(
  db: Kysely<Database>,
  attemptId: number,
  status: PaymentAttemptStatus,
) {
  return db
    .updateTable('payment_attempts')
    .set({
      status,
      ...(status === 'succeeded' ? { processor_charge_id: `ch_${uid()}` } : {}),
      ...(status === 'failed' ? { failure_reason: 'card_declined' } : {}),
    })
    .where('id', '=', attemptId)
    .execute();
}

/** The shortest legal path from 'created' to each status. */
const PATH_FROM_CREATED: Record<PaymentAttemptStatus, PaymentAttemptStatus[]> = {
  created: [],
  calling_processor: ['calling_processor'],
  processing: ['calling_processor', 'processing'],
  requires_action: ['calling_processor', 'requires_action'],
  succeeded: ['calling_processor', 'succeeded'],
  failed: ['calling_processor', 'failed'],
  abandoned: ['calling_processor', 'abandoned'],
};

/** Walks an attempt through legal transitions until it reaches `status`. */
export async function advanceAttemptTo(
  db: Kysely<Database>,
  attemptId: number,
  status: PaymentAttemptStatus,
): Promise<void> {
  for (const step of PATH_FROM_CREATED[status]) {
    await setAttemptStatus(db, attemptId, step);
  }
}

/** A fresh merchant-less intent plus one attempt already in `status`. */
export async function createAttemptInStatus(
  db: Kysely<Database>,
  status: PaymentAttemptStatus,
  merchantId?: number,
): Promise<{ merchantId: number; intentId: number; attemptId: number }> {
  const merchant = merchantId ?? (await createMerchant(db));
  const intentId = await createIntent(db, merchant);
  const attemptId = await createAttempt(db, intentId);
  await advanceAttemptTo(db, attemptId, status);
  return { merchantId: merchant, intentId, attemptId };
}

export async function createLedgerAccount(
  db: Kysely<Database>,
  kind: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense',
  currency = 'NGN',
  code = `acct-${uid()}`,
): Promise<number> {
  const row = await db
    .insertInto('ledger_accounts')
    .values({ code, kind, currency })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function countRows(db: Kysely<Database>, table: keyof Database, where = sql`true`): Promise<number> {
  const { rows } = await sql<{ n: number }>`select count(*) as n from ${sql.table(table)} where ${where}`.execute(db);
  return rows[0].n;
}

export interface TestLedgerEntry {
  accountId: number;
  direction: 'debit' | 'credit';
  amount: number;
  currency?: string;
}

/**
 * Posts one ledger transaction (header plus entries) in a single database transaction, the way
 * production code must (Module 8.5). `entryCount` defaults to the number of entries; override it
 * to build deliberately inconsistent postings in tests.
 *
 * Returns false (and posts nothing) if the posting key was already used: the "second path is a
 * no-op" behaviour from Module 8.4.
 */
export async function postLedgerTransaction(
  db: Kysely<Database>,
  postingKey: string,
  entries: TestLedgerEntry[],
  options: { entryCount?: number; sourceId?: number } = {},
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const header = await trx
      .insertInto('ledger_transactions')
      .values({
        posting_key: postingKey,
        source_type: 'payment_attempt',
        source_id: options.sourceId ?? 1,
        entry_count: options.entryCount ?? entries.length,
      })
      .onConflict((oc) => oc.column('posting_key').doNothing())
      .returning('id')
      .executeTakeFirst();

    if (!header) return false;

    for (const entry of entries) {
      await trx
        .insertInto('ledger_entries')
        .values({
          transaction_id: header.id,
          account_id: entry.accountId,
          direction: entry.direction,
          amount: entry.amount,
          currency: entry.currency ?? 'NGN',
        })
        .execute();
    }
    return true;
  });
}

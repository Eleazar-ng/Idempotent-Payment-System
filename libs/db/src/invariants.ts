import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from './database.types';

export interface InvariantViolation {
  invariant: string;
  detail: string;
}

/**
 * Questions the books must always answer "nothing wrong" to. The database already refuses most of
 * these at commit (migrations 0004 and 0006), so on a healthy system this returns an empty list;
 * it exists to PROVE that after tests and in production (reconciliation in Stage 9, health checks
 * in Stage 10), and to catch what a bug, a restore or a manual `psql` session might have slipped past.
 */
export async function checkLedgerInvariants(db: Kysely<Database>): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];

  const unposted = await sql<{ id: number }>`
    SELECT a.id FROM payment_attempts a
    WHERE a.status = 'succeeded'
      AND NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t.posting_key = 'attempt:' || a.id || ':succeeded')
  `.execute(db);
  for (const row of unposted.rows) {
    violations.push({ invariant: 'succeeded_attempt_has_posting', detail: `attempt ${row.id} succeeded with no posting` });
  }

  const orphan = await sql<{ id: number; source_id: number }>`
    SELECT t.id, t.source_id FROM ledger_transactions t
    WHERE t.source_type = 'payment_attempt'
      AND NOT EXISTS (SELECT 1 FROM payment_attempts a WHERE a.id = t.source_id AND a.status = 'succeeded')
  `.execute(db);
  for (const row of orphan.rows) {
    violations.push({ invariant: 'posting_has_succeeded_attempt', detail: `transaction ${row.id} is for attempt ${row.source_id}, which has not succeeded` });
  }

  const wrongTotal = await sql<{ attempt_id: number; debits: number; amount: number }>`
    SELECT a.id AS attempt_id, COALESCE(sum(e.amount) FILTER (WHERE e.direction = 'debit'), 0)::bigint AS debits, i.amount
    FROM payment_attempts a
    JOIN payment_intents i ON i.id = a.payment_intent_id
    JOIN ledger_transactions t ON t.posting_key = 'attempt:' || a.id || ':succeeded'
    JOIN ledger_entries e ON e.transaction_id = t.id
    GROUP BY a.id, i.amount
    HAVING COALESCE(sum(e.amount) FILTER (WHERE e.direction = 'debit'), 0) <> i.amount
  `.execute(db);
  for (const row of wrongTotal.rows) {
    violations.push({ invariant: 'posting_matches_payment', detail: `attempt ${row.attempt_id} booked ${row.debits} but the payment is ${row.amount}` });
  }

  const unbalanced = await sql<{ currency: string; net: number }>`
    SELECT currency, sum(CASE direction WHEN 'debit' THEN amount ELSE -amount END)::bigint AS net
    FROM ledger_entries GROUP BY currency
    HAVING sum(CASE direction WHEN 'debit' THEN amount ELSE -amount END) <> 0
  `.execute(db);
  for (const row of unbalanced.rows) {
    violations.push({ invariant: 'ledger_balances', detail: `${row.currency} debits minus credits = ${row.net}` });
  }

  const duplicateCharges = await sql<{ intent: number; n: number }>`
    SELECT payment_intent_id AS intent, count(*)::int AS n FROM payment_attempts
    WHERE status = 'succeeded' GROUP BY payment_intent_id HAVING count(*) > 1
  `.execute(db);
  for (const row of duplicateCharges.rows) {
    violations.push({ invariant: 'one_success_per_order', detail: `intent ${row.intent} has ${row.n} succeeded attempts` });
  }

  return violations;
}

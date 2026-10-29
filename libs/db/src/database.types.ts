import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Kysely types for the schema defined by the SQL migrations in libs/db/migrations.
 * The SQL is the source of truth; keep this file in step with it by hand.
 *
 * bigint columns are typed `number`: createDb() parses int8 as a JS number and throws if a value
 * ever exceeds Number.MAX_SAFE_INTEGER (minor-unit money amounts never will).
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** A jsonb column. Writes take a JSON string (JSON.stringify(...)); reads return parsed JSON. */
export type JsonColumn = ColumnType<Json | null, string | null | undefined, string | null | undefined>;

/** A nullable column that may be omitted on insert and set later. */
export type Nullable<T> = ColumnType<T | null, T | null | undefined, T | null | undefined>;

export type PaymentIntentStatus = 'open' | 'succeeded' | 'canceled';

export type PaymentAttemptStatus =
  | 'created'
  | 'calling_processor'
  | 'processing'
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'abandoned';

export type LedgerDirection = 'debit' | 'credit';
export type LedgerAccountKind = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type LedgerSourceType = 'payment_attempt' | 'refund' | 'payout';

export interface MerchantsTable {
  id: Generated<number>;
  name: string;
  /** Where outbox events are delivered (migration 0008). Both set or both null. */
  webhook_url: Nullable<string>;
  webhook_secret: Nullable<string>;
  created_at: Generated<Date>;
}

export interface PaymentIntentsTable {
  id: Generated<number>;
  merchant_id: number;
  order_id: string;
  amount: number;
  currency: string;
  status: Generated<PaymentIntentStatus>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PaymentAttemptsTable {
  id: Generated<number>;
  payment_intent_id: number;
  attempt_number: number;
  status: Generated<PaymentAttemptStatus>;
  processor_idempotency_key: string;
  /** The payment method token for this attempt; immutable, so retries can rebuild the identical request. */
  payment_source: string;
  processor_charge_id: Nullable<string>;
  failure_reason: Nullable<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface IdempotencyKeysTable {
  merchant_id: number;
  idempotency_key: string;
  request_hash: string;
  hash_version: Generated<number>;
  attempt_id: Nullable<number>;
  response_status: Nullable<number>;
  response_body: JsonColumn;
  created_at: Generated<Date>;
  completed_at: Nullable<Date>;
}

export interface StatusTransitionsTable {
  entity: string;
  from_status: string;
  to_status: string;
}

export interface StatusInitialTable {
  entity: string;
  status: string;
}

export interface LedgerAccountsTable {
  id: Generated<number>;
  code: string;
  kind: LedgerAccountKind;
  currency: string;
  created_at: Generated<Date>;
}

export interface LedgerTransactionsTable {
  id: Generated<number>;
  posting_key: string;
  source_type: LedgerSourceType;
  source_id: number;
  entry_count: number;
  created_at: Generated<Date>;
}

export interface LedgerEntriesTable {
  id: Generated<number>;
  transaction_id: number;
  account_id: number;
  direction: LedgerDirection;
  amount: number;
  currency: string;
}

/** Read-only view (migration 0004): net debit per account. Liabilities and revenue read negative. */
export interface LedgerAccountBalancesView {
  account_id: number;
  code: string;
  kind: LedgerAccountKind;
  currency: string;
  net_debit: number;
}

export type WebhookEventResult =
  | 'received'
  | 'applied'
  | 'already_applied'
  | 'ignored'
  | 'unmatched'
  | 'mismatch'
  | 'conflict';

export interface WebhookEventsTable {
  id: Generated<number>;
  source: string;
  event_id: string;
  event_type: string;
  payload: ColumnType<Json, string, string>;
  attempt_id: Nullable<number>;
  result: Generated<WebhookEventResult>;
  detail: Nullable<string>;
  received_at: Generated<Date>;
  processed_at: Nullable<Date>;
}

export type OutboxStatus = 'pending' | 'delivered' | 'skipped' | 'dead';

export interface OutboxEventsTable {
  id: Generated<number>;
  dedupe_key: string;
  merchant_id: number;
  event_type: string;
  payload: ColumnType<Json, string, string>;
  status: Generated<OutboxStatus>;
  attempts: Generated<number>;
  next_attempt_at: Generated<Date>;
  locked_until: Nullable<Date>;
  last_error: Nullable<string>;
  created_at: Generated<Date>;
  delivered_at: Nullable<Date>;
}

export interface SchemaMigrationsTable {
  name: string;
  checksum: string;
  applied_at: Generated<Date>;
}

export interface Database {
  merchants: MerchantsTable;
  payment_intents: PaymentIntentsTable;
  payment_attempts: PaymentAttemptsTable;
  idempotency_keys: IdempotencyKeysTable;
  status_transitions: StatusTransitionsTable;
  status_initial: StatusInitialTable;
  ledger_accounts: LedgerAccountsTable;
  ledger_transactions: LedgerTransactionsTable;
  ledger_entries: LedgerEntriesTable;
  ledger_account_balances: LedgerAccountBalancesView;
  webhook_events: WebhookEventsTable;
  outbox_events: OutboxEventsTable;
  schema_migrations: SchemaMigrationsTable;
}

export type PaymentIntent = Selectable<PaymentIntentsTable>;
export type NewPaymentIntent = Insertable<PaymentIntentsTable>;
export type PaymentIntentUpdate = Updateable<PaymentIntentsTable>;
export type PaymentAttempt = Selectable<PaymentAttemptsTable>;
export type NewPaymentAttempt = Insertable<PaymentAttemptsTable>;
export type PaymentAttemptUpdate = Updateable<PaymentAttemptsTable>;
export type IdempotencyKey = Selectable<IdempotencyKeysTable>;
export type NewIdempotencyKey = Insertable<IdempotencyKeysTable>;
export type WebhookEvent = Selectable<WebhookEventsTable>;
export type OutboxEvent = Selectable<OutboxEventsTable>;

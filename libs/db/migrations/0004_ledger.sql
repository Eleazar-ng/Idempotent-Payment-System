-- 0004_ledger.sql  (Stage 1.4)
--
-- The ledger boundary (Module 8): append-only, double-entry, one posting per business event.
--
-- Three invariants, each enforced by the database rather than by the code that posts:
--   1. Append-only: entries and transactions can never be updated or deleted. Mistakes are fixed
--      with a reversing transaction, which preserves the audit trail.
--   2. Balanced and sealed: within every transaction, debits equal credits per currency, and the
--      number of entries equals the entry_count the transaction declared. Checked at COMMIT by a
--      deferred trigger, so a transaction may insert its entries one at a time, but nobody can
--      add entries to it later (which would quietly rewrite history even if they balance).
--   3. One posting per business event: posting_key is UNIQUE. Every path that learns about the
--      same event (API response, webhook, reconciliation, a redelivered queue message) computes
--      the same key, so exactly one posting happens (Module 8.4).

CREATE TABLE ledger_accounts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        text NOT NULL UNIQUE CHECK (length(code) > 0),   -- e.g. 'processor_receivable'
  kind        text NOT NULL CHECK (kind IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
  currency    text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- Lets ledger_entries reference (account, currency) together, so an entry can never be posted
  -- to an account in a different currency than the entry itself.
  CONSTRAINT ledger_accounts_id_currency UNIQUE (id, currency)
);

CREATE TABLE ledger_transactions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Derived from the business event, never from the transport that reported it, e.g.
  -- 'payment_attempt:981:capture' or 'refund:55'.
  posting_key  text NOT NULL CHECK (length(posting_key) > 0),
  source_type  text NOT NULL CHECK (source_type IN ('payment_attempt', 'refund', 'payout')),
  source_id    bigint NOT NULL,

  -- How many entries this transaction consists of. Seals it: the deferred check below requires
  -- exactly this many entries at commit, so entries cannot be added to it afterwards.
  -- Two is the minimum for anything that balances (at least one debit and one credit).
  entry_count  integer NOT NULL CHECK (entry_count >= 2),
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ledger_transactions_posting_key UNIQUE (posting_key)
);

CREATE TABLE ledger_entries (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id  bigint NOT NULL REFERENCES ledger_transactions (id),
  account_id      bigint NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount          bigint NOT NULL CHECK (amount > 0),   -- integer minor units; never floats
  currency        text NOT NULL,

  CONSTRAINT ledger_entries_account_currency
    FOREIGN KEY (account_id, currency) REFERENCES ledger_accounts (id, currency)
);

CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id);

-- ---------------------------------------------------------------------------------------------
-- Append-only. Accounts are immutable too: re-coding or re-currencying an account would rewrite
-- the meaning of every entry already posted to it.
-- ---------------------------------------------------------------------------------------------

CREATE TRIGGER ledger_accounts_immutable
  BEFORE UPDATE OR DELETE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

CREATE TRIGGER ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

CREATE TRIGGER ledger_transactions_no_truncate
  BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

-- ---------------------------------------------------------------------------------------------
-- Balanced and sealed: the transaction has exactly its declared number of entries, and debits
-- equal credits within each currency.
--
-- Runs deferred, at COMMIT, from two directions:
--   * on ledger_entries      : catches a wrong or unbalanced set of entries, and entries added
--     to an existing transaction later
--   * on ledger_transactions : catches a transaction header inserted with no entries at all
--     (an entries-only trigger would never fire for that case)
--
-- It runs once per inserted row, which is redundant but cheap for the 2 to 4 rows of a payment
-- posting, and keeps the rule trivially correct.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION check_ledger_transaction_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tx_id     bigint;
  expected  integer;
  actual    integer;
  off_cur   text;
  off_net   bigint;
BEGIN
  IF TG_TABLE_NAME = 'ledger_transactions' THEN
    tx_id := NEW.id;
  ELSE
    tx_id := NEW.transaction_id;
  END IF;

  SELECT entry_count INTO expected FROM ledger_transactions WHERE id = tx_id;
  SELECT count(*) INTO actual FROM ledger_entries WHERE transaction_id = tx_id;

  IF actual <> expected THEN
    RAISE EXCEPTION 'ledger transaction % has % entries but declares %', tx_id, actual, expected
      USING ERRCODE = 'PY005';
  END IF;

  SELECT currency, sum(CASE direction WHEN 'debit' THEN amount ELSE -amount END)
  INTO off_cur, off_net
  FROM ledger_entries
  WHERE transaction_id = tx_id
  GROUP BY currency
  HAVING sum(CASE direction WHEN 'debit' THEN amount ELSE -amount END) <> 0
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'ledger transaction % does not balance in % (debits minus credits = %)',
      tx_id, off_cur, off_net
      USING ERRCODE = 'PY005';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_ledger_transaction_balanced();

CREATE CONSTRAINT TRIGGER ledger_transactions_balanced
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_ledger_transaction_balanced();

-- ---------------------------------------------------------------------------------------------
-- Balances are derived from entries, which are the truth (Module 8.2). Positive net_debit means
-- the account is net debited. Whether that is "good" depends on the account kind: an asset
-- normally carries a debit balance, a liability or revenue account a credit balance.
-- ---------------------------------------------------------------------------------------------

CREATE VIEW ledger_account_balances AS
SELECT
  a.id        AS account_id,
  a.code,
  a.kind,
  a.currency,
  COALESCE(sum(CASE e.direction WHEN 'debit' THEN e.amount ELSE -e.amount END), 0)::bigint AS net_debit
FROM ledger_accounts a
LEFT JOIN ledger_entries e ON e.account_id = a.id
GROUP BY a.id, a.code, a.kind, a.currency;

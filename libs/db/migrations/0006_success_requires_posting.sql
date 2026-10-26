-- 0006_success_requires_posting.sql  (Stage 6)
--
-- New SQLSTATE: PY006  an attempt's success and its ledger posting do not match.
--
-- The rule: an attempt is 'succeeded' if and only if its ledger posting exists, and the posting
-- adds up to the payment. Both sides are checked when the transaction COMMITS (deferred), so the
-- only way to satisfy them is to write the status change and the posting in ONE transaction.
--
-- Why in the database and not just in the application: Stage 7's webhook handler, Stage 9's
-- reconciliation and any future code path all move attempts to 'succeeded'. If each had to remember
-- to post, one forgotten call would mean a customer was charged and the books never heard of it.
-- Here a forgotten call fails the transaction instead.

-- ---------------------------------------------------------------------------------------------
-- Side 1: an attempt that BECOMES succeeded must have a matching posting by commit.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION require_posting_for_succeeded_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_tx_id        bigint;
  v_amount       bigint;
  v_currency     text;
  v_debits       bigint;
  v_off_currency bigint;
BEGIN
  SELECT id INTO v_tx_id
  FROM ledger_transactions
  WHERE posting_key = 'attempt:' || NEW.id || ':succeeded'
    AND source_type = 'payment_attempt'
    AND source_id = NEW.id;

  IF v_tx_id IS NULL THEN
    RAISE EXCEPTION 'payment attempt % succeeded without its ledger posting', NEW.id
      USING ERRCODE = 'PY006';
  END IF;

  SELECT amount, currency INTO v_amount, v_currency
  FROM payment_intents
  WHERE id = NEW.payment_intent_id;

  SELECT COALESCE(sum(amount) FILTER (WHERE direction = 'debit'), 0),
         count(*) FILTER (WHERE currency <> v_currency)
  INTO v_debits, v_off_currency
  FROM ledger_entries
  WHERE transaction_id = v_tx_id;

  -- The posting already balances (0004). Here: does it book the amount that was actually charged?
  IF v_off_currency > 0 OR v_debits <> v_amount THEN
    RAISE EXCEPTION
      'ledger posting for attempt % books % debits (and % off-currency entries) but the payment is % %',
      NEW.id, v_debits, v_off_currency, v_amount, v_currency
      USING ERRCODE = 'PY006';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER payment_attempts_success_needs_posting
  AFTER UPDATE OF status ON payment_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status = 'succeeded' AND OLD.status IS DISTINCT FROM 'succeeded')
  EXECUTE FUNCTION require_posting_for_succeeded_attempt();

-- ---------------------------------------------------------------------------------------------
-- Side 2: a posting for an attempt must belong to an attempt that has succeeded by commit.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION require_succeeded_attempt_for_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM payment_attempts WHERE id = NEW.source_id AND status = 'succeeded'
  ) THEN
    RAISE EXCEPTION 'ledger transaction % is for payment attempt % which has not succeeded', NEW.id, NEW.source_id
      USING ERRCODE = 'PY006';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER ledger_transactions_attempt_must_have_succeeded
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.source_type = 'payment_attempt')
  EXECUTE FUNCTION require_succeeded_attempt_for_posting();

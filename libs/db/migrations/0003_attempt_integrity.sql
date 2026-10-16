-- 0003_attempt_integrity.sql  (Stage 1.3)
--
-- Failure mode 2.7: "two attempts for the same order both succeed". Everything here makes that
-- structurally impossible instead of merely unlikely.

-- ---------------------------------------------------------------------------------------------
-- At most one ACTIVE attempt per intent.
--
-- "Active" means every status except 'failed'. This is a deliberate correction to Module 5.11,
-- which excluded 'abandoned' as well. An abandoned attempt means "we do not know what the
-- processor did", and reconciliation may still discover it succeeded (abandoned -> succeeded is a
-- legal transition). If a new attempt were allowed in the meantime, the customer could be
-- charged twice. So an unknown outcome blocks new attempts until reconciliation resolves it to
-- succeeded or failed. The cost is a short wait for the customer; the alternative is a double
-- charge.
--
-- The unique violation (23505) raised here is the same atomic-claim mechanism as the
-- idempotency key, one level up.
-- ---------------------------------------------------------------------------------------------

CREATE UNIQUE INDEX payment_attempts_one_active_per_intent
  ON payment_attempts (payment_intent_id)
  WHERE status <> 'failed';

-- ---------------------------------------------------------------------------------------------
-- No new attempt on an intent that is not open.
--
-- FOR SHARE locks the intent row for the rest of the transaction. Cancelling an intent updates
-- that row, so a cancel and an attempt-insert for the same intent are forced into a single
-- order instead of racing past each other's checks.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION guard_attempt_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  intent_status text;
BEGIN
  SELECT status INTO intent_status
  FROM payment_intents
  WHERE id = NEW.payment_intent_id
  FOR SHARE;

  IF intent_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'cannot create an attempt for intent % (status: %)',
      NEW.payment_intent_id, COALESCE(intent_status, 'missing')
      USING ERRCODE = 'PY004';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER payment_attempts_guard_insert
  BEFORE INSERT ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_attempt_insert();

-- ---------------------------------------------------------------------------------------------
-- An intent's terminal states must be consistent with its attempts:
--   succeeded  requires a succeeded attempt (the only legitimate path is the propagation
--              trigger from 0002; this stops anyone marking an order paid by hand)
--   canceled   requires that no attempt is still active, because money may be moving
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION guard_intent_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'succeeded' THEN
    IF NOT EXISTS (
      SELECT 1 FROM payment_attempts
      WHERE payment_intent_id = NEW.id AND status = 'succeeded'
    ) THEN
      RAISE EXCEPTION 'intent % cannot be marked succeeded without a succeeded attempt', NEW.id
        USING ERRCODE = 'PY004';
    END IF;
  ELSIF NEW.status = 'canceled' THEN
    IF EXISTS (
      SELECT 1 FROM payment_attempts
      WHERE payment_intent_id = NEW.id AND status <> 'failed'
    ) THEN
      RAISE EXCEPTION 'intent % cannot be canceled while an attempt is active', NEW.id
        USING ERRCODE = 'PY004';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER payment_intents_guard_status
  BEFORE UPDATE ON payment_intents
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION guard_intent_status();

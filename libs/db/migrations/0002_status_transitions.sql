-- 0002_status_transitions.sql  (Stage 1.2)
--
-- The payment state machine (Module 5), enforced by the database itself rather than hoped for in
-- application code. One pair of reference tables and one trigger function serve every entity, so
-- adding a state machine later is data plus one CREATE TRIGGER.
--
-- Two deliberate differences from the Module 5 lecture tables:
--   * 'refunded' and 'disputed' are NOT attempt states. Module 8.8 made refunds their own entity
--     and left the attempt 'succeeded', so those edges do not belong on this machine.
--   * calling_processor -> requires_action is allowed: a processor can ask for 3-D Secure in the
--     very response to the charge call, without an intermediate 'processing' step.

CREATE TABLE status_transitions (
  entity       text NOT NULL,
  from_status  text NOT NULL,
  to_status    text NOT NULL,
  PRIMARY KEY (entity, from_status, to_status)
);

-- The states a row may be INSERTed in. Without this, a row could be created directly in
-- 'succeeded' and never pass through the machine at all.
CREATE TABLE status_initial (
  entity  text NOT NULL,
  status  text NOT NULL,
  PRIMARY KEY (entity, status)
);

INSERT INTO status_initial (entity, status) VALUES
  ('payment_attempt', 'created'),
  ('payment_intent',  'open');

INSERT INTO status_transitions (entity, from_status, to_status) VALUES
  -- payment_attempt (Module 5.3)
  ('payment_attempt', 'created',           'calling_processor'),
  ('payment_attempt', 'calling_processor', 'processing'),
  ('payment_attempt', 'calling_processor', 'requires_action'),
  ('payment_attempt', 'calling_processor', 'succeeded'),
  ('payment_attempt', 'calling_processor', 'failed'),
  ('payment_attempt', 'calling_processor', 'abandoned'),
  ('payment_attempt', 'processing',        'requires_action'),
  ('payment_attempt', 'processing',        'succeeded'),
  ('payment_attempt', 'processing',        'failed'),
  ('payment_attempt', 'processing',        'abandoned'),
  ('payment_attempt', 'requires_action',   'processing'),
  ('payment_attempt', 'requires_action',   'failed'),
  ('payment_attempt', 'abandoned',         'succeeded'),   -- reconciliation found it did succeed
  ('payment_attempt', 'abandoned',         'failed'),      -- reconciliation found it did not
  -- payment_intent (Module 5.9)
  ('payment_intent',  'open',              'succeeded'),
  ('payment_intent',  'open',              'canceled');

-- Usage: EXECUTE FUNCTION enforce_status_transition('<entity>')
--
-- On INSERT: the starting status must be listed in status_initial.
-- On UPDATE: (old status, new status) must be listed in status_transitions. A no-op "update"
-- that leaves status unchanged is always fine.
--
-- Runs as a BEFORE ROW trigger, ahead of CHECK constraints, so an illegal move is reported as
-- an illegal move (PY001) rather than as a side effect of some other constraint.
CREATE FUNCTION enforce_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entity_name text := TG_ARGV[0];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM status_initial WHERE entity = entity_name AND status = NEW.status
    ) THEN
      RAISE EXCEPTION 'Invalid initial % status: %', entity_name, NEW.status USING ERRCODE = 'PY001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM status_transitions
    WHERE entity = entity_name AND from_status = OLD.status AND to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'Invalid % status transition: % -> %', entity_name, OLD.status, NEW.status
      USING ERRCODE = 'PY001';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER payment_attempts_enforce_status
  BEFORE INSERT OR UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION enforce_status_transition('payment_attempt');

CREATE TRIGGER payment_intents_enforce_status
  BEFORE INSERT OR UPDATE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION enforce_status_transition('payment_intent');

-- ---------------------------------------------------------------------------------------------
-- Connecting the two machines (Module 5.10): an intent becomes 'succeeded' when, and only when,
-- one of its attempts becomes 'succeeded'. Doing it in a trigger means the two changes commit
-- together or not at all; there is no window where the attempt says succeeded and the intent
-- still says open.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION propagate_attempt_success() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Conditional write, same principle as Module 4.4: only move an intent that is still open.
  UPDATE payment_intents
  SET status = 'succeeded'
  WHERE id = NEW.payment_intent_id AND status = 'open';

  IF NOT FOUND THEN
    -- The attempt succeeded at the processor but its intent is not open (for example already
    -- succeeded through another attempt, or canceled). Refuse to record it here: this is the
    -- double-payment case (failure mode 2.7) and must be handled explicitly, not hidden.
    RAISE EXCEPTION 'attempt % succeeded but intent % is not open', NEW.id, NEW.payment_intent_id
      USING ERRCODE = 'PY004';
  END IF;

  RETURN NULL;
END
$$;

CREATE TRIGGER payment_attempts_propagate_success
  AFTER UPDATE OF status ON payment_attempts
  FOR EACH ROW
  WHEN (NEW.status = 'succeeded' AND OLD.status IS DISTINCT FROM 'succeeded')
  EXECUTE FUNCTION propagate_attempt_success();

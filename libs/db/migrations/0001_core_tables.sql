-- 0001_core_tables.sql  (Stage 1.1)
--
-- Core tables plus two small generic trigger functions.
--
-- Custom SQLSTATE codes used across these migrations, so the application and the tests can tell
-- "the database refused this on purpose" apart from ordinary failures:
--   PY001  invalid status transition                 (0002)
--   PY002  immutable / write-once column changed     (0001)
--   PY003  append-only or frozen row modified        (0001, 0004)
--   PY004  payment intent / attempt integrity rule   (0002, 0003)
--   PY005  ledger transaction does not balance       (0004)

-- ---------------------------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------------------------

-- Keeps updated_at honest without relying on every UPDATE statement remembering it.
-- The recovery sweeper (Module 9.2) depends on updated_at to find stuck attempts.
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Usage: EXECUTE FUNCTION forbid_column_updates('col_a', 'col_b')
-- The named columns can never change after insert.
CREATE FUNCTION forbid_column_updates() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  col text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
      RAISE EXCEPTION '%.% is immutable', TG_TABLE_NAME, col USING ERRCODE = 'PY002';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

-- Usage: EXECUTE FUNCTION forbid_update_once_set('col_a')
-- The named columns may go from NULL to a value, but never change again once set.
CREATE FUNCTION forbid_update_once_set() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  col text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF to_jsonb(OLD) -> col <> 'null'::jsonb
       AND to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
      RAISE EXCEPTION '%.% is write-once and is already set', TG_TABLE_NAME, col USING ERRCODE = 'PY002';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

-- Usage: EXECUTE FUNCTION forbid_modification()  (typically with a WHEN clause or on a whole table)
CREATE FUNCTION forbid_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows cannot be % (append-only or frozen)', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'PY003';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- merchants
-- ---------------------------------------------------------------------------------------------

CREATE TABLE merchants (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- payment_intents: "did this order get paid?" One per order, aggregating its attempts.
--
-- status is validated by the transition tables in 0002, not by a CHECK list here, so the set of
-- valid states lives in exactly one place.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE payment_intents (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  merchant_id  bigint NOT NULL REFERENCES merchants (id),
  order_id     text NOT NULL CHECK (length(order_id) BETWEEN 1 AND 255),
  amount       bigint NOT NULL CHECK (amount > 0),       -- integer minor units (kobo, cents)
  currency     text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status       text NOT NULL DEFAULT 'open',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- One intent per order per merchant: any trigger path that derives the intent from the order
  -- converges on the same row (closes the intent-level half of failure mode 2.4).
  CONSTRAINT payment_intents_one_per_order UNIQUE (merchant_id, order_id)
);

-- What was asked for must never drift, or retries could not rebuild the identical request
-- body (Module 3.4).
CREATE TRIGGER payment_intents_immutable
  BEFORE UPDATE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION forbid_column_updates('id', 'merchant_id', 'order_id', 'amount', 'currency', 'created_at');

CREATE TRIGGER payment_intents_touch
  BEFORE UPDATE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- payment_attempts: one row per attempt to move money. Each runs the Module 5 state machine
-- and ends in its own terminal state, so history stays unambiguous (Module 5.8 to 5.9).
-- ---------------------------------------------------------------------------------------------

CREATE TABLE payment_attempts (
  id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_intent_id          bigint NOT NULL REFERENCES payment_intents (id),
  attempt_number             integer NOT NULL CHECK (attempt_number > 0),
  status                     text NOT NULL DEFAULT 'created',

  -- The key we send to the processor on every (re)try of this attempt. It is assigned when the
  -- attempt row is created, i.e. durably persisted before any outbound call (Module 2.3).
  --
  -- It must be unique across ALL merchants, because the processor sees one account (ours), not
  -- one per merchant. Derive it from the intent id plus attempt number (globally unique), not
  -- from order_id, which is only unique per merchant.
  processor_idempotency_key  text NOT NULL CHECK (length(processor_idempotency_key) > 0),
  processor_charge_id        text,
  failure_reason             text,

  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payment_attempts_number_per_intent UNIQUE (payment_intent_id, attempt_number),
  CONSTRAINT payment_attempts_processor_key_unique UNIQUE (processor_idempotency_key),
  -- The same processor charge can never be attached to two attempts (reconciliation join key).
  CONSTRAINT payment_attempts_charge_unique UNIQUE (processor_charge_id),

  -- A success we cannot point to at the processor is not a success we can reconcile.
  CONSTRAINT payment_attempts_succeeded_has_charge
    CHECK (status <> 'succeeded' OR processor_charge_id IS NOT NULL),
  -- A failure must say why; support and reconciliation both need it.
  CONSTRAINT payment_attempts_failed_has_reason
    CHECK (status <> 'failed' OR failure_reason IS NOT NULL)
);

CREATE TRIGGER payment_attempts_immutable
  BEFORE UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION forbid_column_updates(
    'id', 'payment_intent_id', 'attempt_number', 'processor_idempotency_key', 'created_at'
  );

-- Once the processor has told us the charge id, it can never be re-pointed.
CREATE TRIGGER payment_attempts_charge_write_once
  BEFORE UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION forbid_update_once_set('processor_charge_id');

CREATE TRIGGER payment_attempts_touch
  BEFORE UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- idempotency_keys: the API-level claim ticket (Module 3). The primary key IS the atomic claim:
--   INSERT ... ON CONFLICT (merchant_id, idempotency_key) DO NOTHING RETURNING ...
-- Scoped per merchant so unrelated merchants can never collide (Module 3.5).
--
-- Kept separate from payment_attempts so expiry and cleanup of keys never touches financial
-- records (Module 10.4).
-- ---------------------------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  merchant_id      bigint NOT NULL REFERENCES merchants (id),
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),

  -- Hash of the canonicalized request body, and which version of the hash function made it, so
  -- changing the function later cannot reject in-flight retries (Module 3.4 and 11.3).
  request_hash     text NOT NULL CHECK (length(request_hash) > 0),
  hash_version     smallint NOT NULL DEFAULT 1,

  attempt_id       bigint REFERENCES payment_attempts (id),

  -- The response to replay on duplicates. Both NULL while the request is still in flight.
  response_status  smallint CHECK (response_status BETWEEN 100 AND 599),
  response_body    jsonb,

  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,

  PRIMARY KEY (merchant_id, idempotency_key),

  -- "Completed" is one fact: it has a completion time exactly when it has a response status.
  CONSTRAINT idempotency_keys_completion_consistent
    CHECK ((completed_at IS NULL) = (response_status IS NULL)),
  CONSTRAINT idempotency_keys_body_needs_completion
    CHECK (response_body IS NULL OR completed_at IS NOT NULL)
);

-- A key's identity never changes: same key plus a different payload must be rejected, not
-- silently re-bound (Module 3.4).
CREATE TRIGGER idempotency_keys_immutable
  BEFORE UPDATE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION forbid_column_updates(
    'merchant_id', 'idempotency_key', 'request_hash', 'hash_version', 'created_at'
  );

-- Once completed, the stored response is frozen: replays must return exactly what the first
-- request returned. (DELETE stays allowed, because expiry cleanup removes old keys.)
CREATE TRIGGER idempotency_keys_frozen_after_completion
  BEFORE UPDATE ON idempotency_keys
  FOR EACH ROW WHEN (OLD.completed_at IS NOT NULL)
  EXECUTE FUNCTION forbid_modification();

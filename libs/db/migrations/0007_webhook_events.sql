-- 0007_webhook_events.sql  (Stage 7)
--
-- One row per webhook event the processor has delivered to us, keyed by the processor's own event
-- id. Processors deliver AT LEAST ONCE, so the same event arrives twice, late, or out of order; the
-- unique key is what turns "twice" into "once".
--
-- The row is written in the SAME transaction as the effect of the event (the attempt status change
-- and its ledger posting). If anything fails the row rolls back with it, the receiver answers 5xx,
-- and the processor's redelivery gets another go. A row therefore always means "this event was fully
-- handled", never "this event was seen".
--
-- result says what handling did:
--   received       transient: only ever visible inside the handling transaction
--   applied        moved the attempt to the state the event describes
--   already_applied  the attempt was already there (the API response or another event got there first)
--   ignored        an event type we do not act on
--   unmatched      names a charge that no attempt of ours explains
--   mismatch       amount or currency disagree with the payment; NOT applied
--   conflict       contradicts a state we cannot leave (for example succeeded on a failed attempt);
--                  NOT applied. These rows are the work queue for reconciliation (Stage 9).

CREATE TABLE webhook_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source       text NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  event_id     text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 255),
  event_type   text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 255),
  payload      jsonb NOT NULL,
  attempt_id   bigint REFERENCES payment_attempts (id),
  result       text NOT NULL DEFAULT 'received'
               CHECK (result IN ('received', 'applied', 'already_applied', 'ignored', 'unmatched', 'mismatch', 'conflict')),
  detail       text,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,

  CONSTRAINT webhook_events_one_per_event UNIQUE (source, event_id),
  -- An event that changed (or confirmed) an attempt must say which one.
  CONSTRAINT webhook_events_applied_has_attempt
    CHECK (result NOT IN ('applied', 'already_applied') OR attempt_id IS NOT NULL),
  CONSTRAINT webhook_events_processed_consistent
    CHECK ((result = 'received') = (processed_at IS NULL))
);

-- Reconciliation looks for unresolved conflicts and mismatches.
CREATE INDEX webhook_events_needs_attention
  ON webhook_events (received_at)
  WHERE result IN ('mismatch', 'conflict', 'unmatched');

-- What was received never changes.
CREATE TRIGGER webhook_events_immutable
  BEFORE UPDATE ON webhook_events
  FOR EACH ROW EXECUTE FUNCTION forbid_column_updates('id', 'source', 'event_id', 'event_type', 'payload', 'received_at');

-- Once handled, the record is frozen: the verdict is history. (DELETE stays allowed for retention.)
CREATE TRIGGER webhook_events_frozen_after_handling
  BEFORE UPDATE ON webhook_events
  FOR EACH ROW WHEN (OLD.result <> 'received')
  EXECUTE FUNCTION forbid_modification();

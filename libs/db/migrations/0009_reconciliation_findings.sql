-- 0009_reconciliation_findings.sql  (Stage 9)
--
-- The work queue for things the system must NOT fix by itself. Recovery and reconciliation move an
-- attempt only when the processor has told us something definitive and the move is legal. When the two
-- sides contradict a final state ("the customer was charged but we hold the attempt as failed"), moving
-- the attempt would overwrite money state on the strength of a lookup. Instead a finding is recorded,
-- once, and stays open until a person (or a later run that sees the contradiction gone) resolves it.
--
-- dedupe_key makes recording idempotent: the same discrepancy seen on every hourly run is ONE row whose
-- seen_count grows, not a new alert per run.
--
-- source:
--   recovery        found by the sweeper while looking at one stuck attempt
--   reconciliation  found by comparing our attempts with the processor's charges
--   webhook         a webhook event recorded as conflict/mismatch/unmatched (Stage 7), tracked here
--                   so it has an owner and a resolution

CREATE TABLE reconciliation_findings (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedupe_key     text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 255),
  kind           text NOT NULL CHECK (length(kind) BETWEEN 1 AND 100),
  source         text NOT NULL CHECK (source IN ('recovery', 'reconciliation', 'webhook')),
  attempt_id     bigint REFERENCES payment_attempts (id),
  charge_id      text,
  detail         text NOT NULL CHECK (length(detail) > 0),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  seen_count     integer NOT NULL DEFAULT 1 CHECK (seen_count >= 1),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  resolution     text,

  CONSTRAINT reconciliation_findings_dedupe UNIQUE (dedupe_key),
  -- "resolved" is one fact: it has a time and a reason exactly when it is resolved.
  CONSTRAINT reconciliation_findings_resolution_consistent
    CHECK ((status = 'resolved') = (resolved_at IS NOT NULL) AND (status = 'resolved') = (resolution IS NOT NULL))
);

CREATE INDEX reconciliation_findings_open ON reconciliation_findings (kind, first_seen_at) WHERE status = 'open';

-- What was found never changes; only its status, counters and wording do.
CREATE TRIGGER reconciliation_findings_immutable
  BEFORE UPDATE ON reconciliation_findings
  FOR EACH ROW EXECUTE FUNCTION forbid_column_updates('id', 'dedupe_key', 'kind', 'source', 'attempt_id', 'charge_id', 'first_seen_at');

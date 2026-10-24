-- 0005_attempt_payment_source.sql  (Stage 5)
--
-- An attempt must be able to rebuild the EXACT charge request it first sent. The processor
-- compares parameters when it sees a repeated idempotency key, so a retry from a different request,
-- a worker, or a restarted process has to send identical amount, currency, metadata AND payment
-- source. Amount and currency already live on the intent; the source did not live anywhere.
--
-- Added NOT NULL with no lasting default: an attempt without a source must be impossible, not
-- silently charge some default. (The temporary default only covers rows that exist before this
-- migration, then it is dropped.)

ALTER TABLE payment_attempts
  ADD COLUMN payment_source text NOT NULL DEFAULT 'legacy'
  CONSTRAINT payment_attempts_source_length CHECK (length(payment_source) BETWEEN 1 AND 255);

ALTER TABLE payment_attempts ALTER COLUMN payment_source DROP DEFAULT;

-- Same as the 0001 trigger, plus the new column: what was asked for never changes after insert.
DROP TRIGGER payment_attempts_immutable ON payment_attempts;

CREATE TRIGGER payment_attempts_immutable
  BEFORE UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION forbid_column_updates(
    'id', 'payment_intent_id', 'attempt_number', 'processor_idempotency_key', 'payment_source', 'created_at'
  );

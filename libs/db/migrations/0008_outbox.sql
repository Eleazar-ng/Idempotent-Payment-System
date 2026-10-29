-- 0008_outbox.sql  (Stage 8)
--
-- The transactional outbox: telling a merchant "your payment succeeded" must happen if and only if the
-- payment really did succeed. Sending the HTTP request inside the payment transaction cannot give that
-- (the request may succeed and the commit fail, or the reverse), so the transaction only WRITES a row
-- here, and a separate relay delivers it afterwards, at least once, retrying until it works.
--
-- merchants gain the place to send to: a URL and the secret used to sign what we send.

ALTER TABLE merchants
  ADD COLUMN webhook_url    text CONSTRAINT merchants_webhook_url_shape CHECK (webhook_url IS NULL OR webhook_url ~ '^https?://[^\s]+$'),
  ADD COLUMN webhook_secret text CONSTRAINT merchants_webhook_secret_length CHECK (webhook_secret IS NULL OR length(webhook_secret) >= 16),
  ADD CONSTRAINT merchants_webhook_all_or_nothing CHECK ((webhook_url IS NULL) = (webhook_secret IS NULL));

-- status:
--   pending    waiting to be delivered, or to be retried at next_attempt_at
--   delivered  the merchant answered 2xx
--   skipped    the merchant had no webhook URL when we got to it
--   dead       gave up after max attempts; needs a human (and can be requeued)
CREATE TABLE outbox_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- One event per business fact: "payment.succeeded:attempt:12". Writing it twice (the API response and
  -- a webhook both finishing the same attempt) is a no-op.
  dedupe_key       text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 255),
  merchant_id      bigint NOT NULL REFERENCES merchants (id),
  event_type       text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 255),
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'skipped', 'dead')),
  -- Counted when a delivery is CLAIMED, not when it finishes, so a worker that dies mid-delivery still
  -- uses up an attempt and a poison event cannot loop forever.
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  -- A claim is a lease: if the worker dies, the row becomes due again when the lease runs out.
  locked_until     timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz,

  CONSTRAINT outbox_events_dedupe UNIQUE (dedupe_key),
  CONSTRAINT outbox_events_delivered_time CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CONSTRAINT outbox_events_dead_says_why CHECK (status <> 'dead' OR last_error IS NOT NULL)
);

-- The relay's only query: what is due?
CREATE INDEX outbox_events_due ON outbox_events (next_attempt_at, id) WHERE status = 'pending';
CREATE INDEX outbox_events_dead ON outbox_events (created_at) WHERE status = 'dead';

-- What the event says never changes.
CREATE TRIGGER outbox_events_immutable
  BEFORE UPDATE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION forbid_column_updates('id', 'dedupe_key', 'merchant_id', 'event_type', 'payload', 'created_at');

-- Delivered and skipped are final. (dead is not: a person may requeue it.) DELETE stays allowed for retention.
CREATE TRIGGER outbox_events_frozen_when_final
  BEFORE UPDATE ON outbox_events
  FOR EACH ROW WHEN (OLD.status IN ('delivered', 'skipped'))
  EXECUTE FUNCTION forbid_modification();

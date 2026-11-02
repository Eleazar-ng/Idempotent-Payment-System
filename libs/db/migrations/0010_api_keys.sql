-- 0010_api_keys.sql  (Stage 11)
--
-- Real authentication. Until now the API trusted a header that merely NAMED a merchant (X-Merchant-Id), so anyone who could
-- reach it could act as any merchant. A merchant now proves who it is with a secret key.
--
-- What is stored: the key's public prefix (to find the row) and a SHA-256 of the whole key (to check it). The key itself is
-- shown once, at creation, and exists nowhere else. A leaked copy of this table does not leak working keys.
--
-- A key is usable while it is not revoked and not expired. Neither can be undone: a revoked key stays revoked, and expiry is
-- fixed at creation (extending a key's life is making a new key). A merchant can hold several keys at once, which is how
-- rotation works: create the new key, deploy it, revoke the old one.

CREATE TABLE api_keys (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  merchant_id   bigint NOT NULL REFERENCES merchants (id),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  key_prefix    text NOT NULL CHECK (key_prefix ~ '^[0-9a-f]{12}$'),
  key_hash      text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  -- Updated at most once a minute per key (see api-keys.ts): enough to see a key is dead weight, cheap enough for every request.
  last_used_at  timestamptz,
  revoked_at    timestamptz,

  CONSTRAINT api_keys_prefix_unique UNIQUE (key_prefix),
  CONSTRAINT api_keys_expiry_after_creation CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX api_keys_by_merchant ON api_keys (merchant_id, created_at);

-- Who owns a key, what it looks like, what it hashes to, and when it dies never change. Revoking is the only way to end a key,
-- and once revoked it stays revoked.
CREATE TRIGGER api_keys_immutable
  BEFORE UPDATE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION forbid_column_updates('id', 'merchant_id', 'name', 'key_prefix', 'key_hash', 'created_at', 'expires_at');

CREATE TRIGGER api_keys_revocation_final
  BEFORE UPDATE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION forbid_update_once_set('revoked_at');

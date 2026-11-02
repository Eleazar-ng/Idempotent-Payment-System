# Security notes (Stage 11)

What this stage hardens, what it deliberately does not, and how to operate it.

## Authentication: API keys

Every `/v1/*` call sends `Authorization: Bearer <api key>`. The merchant is whoever the key belongs to. Nothing else names a merchant:
the old `X-Merchant-Id` header is ignored, and a request carrying only that header gets a 401.

**Key format.** `pk_<12 hex>_<43 base64url>`. The 12 hex characters are a public *prefix* (finds the row; the only part ever logged
or listed). The rest is 256 random bits, shown once at creation.

**Storage.** Only `SHA-256(key)` is stored (`api_keys`, migration 0010). A fast hash is right here and a password hash is not: bcrypt/argon2 slow down guessing
of *human* passwords, and a 256-bit random secret cannot be guessed at any speed. A leaked table does not leak working keys.

**Checking a key** (`authenticateApiKey`):

1. the shape is checked before the database is asked anything (garbage never costs a query);
2. the row is found by prefix and the hash compared in constant time, **also when the prefix is unknown** (a dummy hash), so "no such key" costs the same as "wrong secret";
3. revoked and expired are checked only after the secret matched, so a stranger cannot learn which prefixes are revoked;
4. `last_used_at` is written at most once a minute per key, and a failure to write it never fails the request.

**One answer for every failure.** No header, malformed, unknown, wrong secret, revoked, expired: the caller always gets the same `401 invalid_api_key`
(`authentication_required` when there is no header at all) with `WWW-Authenticate: Bearer realm="payments"`. The reason goes to the log
(`api key rejected: revoked (prefix 3fa9…)`) and the count to `auth_attempts_total`. Presented keys never reach a log: the logger scrubs anything
shaped like a key down to its prefix.

**Lifecycle.** A key can end in two ways, revocation and expiry, and neither can be undone: the database refuses to change `expires_at`, un-revoke, or alter the
hash, prefix, owner or name (triggers, `PY002`). To extend a key's life, make a new key.

**Operating** (`pnpm admin <command>`; there is no public sign-up, by design):

```
pnpm admin merchant:create "Acme Ltd"     creates the merchant and its first key (printed once)
pnpm admin key:create 12 "ci server"      adds a key for merchant 12
pnpm admin key:revoke 3fa9c0d1e2b4        ends a key at once
pnpm admin key:list 12                    prefixes, state, last used. Never the secrets
```

**Rotation without downtime:** `key:create` → deploy the new key → watch `key:list` until the old key's *last used* stops moving → `key:revoke` the old one.

## Merchant webhook endpoints

A merchant manages where its events go with its own key:

| Call | Does |
|---|---|
| `PUT /v1/webhook-endpoint` `{"url": "https://…"}` | Registers or changes the URL. First time: `201` with a signing `secret`, **shown once**. Later: `200`, secret kept. |
| `GET /v1/webhook-endpoint` | The URL. Never the secret. `404` if none. |
| `POST /v1/webhook-endpoint/secret` | Rotates the secret; the new one is shown once. Events are signed at send time, so they use it from the next attempt. |
| `DELETE /v1/webhook-endpoint` | Removes both. Undelivered events are then skipped. |

Registration refuses (`422 invalid_webhook_url`, with a machine-readable `reason`) anything the delivery policy would refuse, and requires the host name to
resolve (`422 webhook_host_unresolvable`), so a merchant learns now rather than from a dead event later. A rejected change leaves the existing endpoint untouched.

## SSRF: why webhook URLs are dangerous, and the two layers against it

A webhook URL is an address a *customer* gets our server to call. Pointed at `http://169.254.169.254/latest/meta-data/` (the cloud credential service),
`http://localhost:5432`, or `http://10.0.0.7/admin`, our server, which sits inside the network, makes the request for them. Even when the response is never shown
to them, timing and status codes leak, and a POST with attacker-chosen headers can change state.

**Layer 1: the URL policy** (`checkWebhookUrl`, pure, at registration and again at delivery):

- `https` only (`http` only when `WEBHOOK_ALLOW_HTTP=true`);
- no username or password in the URL;
- no internal names (`localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa`);
- no internal or reserved **addresses**: loopback, RFC 1918, link-local (including the metadata service), carrier-grade NAT, multicast, reserved, documentation
  ranges; IPv6 loopback, unique-local, link-local, multicast, Teredo, 6to4; **IPv4 hidden inside IPv6** (`::ffff:127.0.0.1`, `::ffff:7f00:1`, NAT64 `64:ff9b::…`) is
  judged by the IPv4 inside;
- checked on the **parsed** host, never the raw text, so `2130706433`, `0x7f000001`, `0177.0.0.1` and `127.1` (all `127.0.0.1`) are caught;
- no ports below 1024 except 80 and 443.

**Layer 2: the connection** (`createSafeFetch`, at every delivery). A URL that was fine at registration can stop being fine: DNS answers change (**DNS rebinding**: a name that
resolved to a public address when checked and to an internal one when used), and rows can be written without going through the API. So at delivery:

- the name is resolved **by us**, **every** returned address must be allowed (one internal address among public ones is refused), and the connection is made to the
  address that was checked. The HTTP client never resolves the name itself, so nothing can change between check and connect;
- TLS still verifies the certificate against the host **name**;
- redirects are never followed (a 3xx is just a failed delivery), so a merchant cannot bounce a signed body somewhere unregistered;
- the response body is never read, so a slow or endless body cannot hold a worker.

A destination the policy refuses is **not retried**: the event goes straight to `dead` with `blocked_destination: <reason>`, because retrying cannot change the answer.
A name that merely fails to resolve *is* retried (DNS blips happen).

**Development switches.** `WEBHOOK_ALLOW_HTTP` and `WEBHOOK_ALLOW_PRIVATE_NETWORKS` default to `false` in code and are `true` in `.env.example` because local development
needs `http://localhost` merchants. **Never set them in production**; both the API and the worker log a warning at start-up when either is on.

## Other hardening

- Responses carry `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`, and no `X-Powered-By`. HSTS belongs to the proxy that terminates TLS.
- The processor's webhook secret can be rotated without downtime: set `PROCESSOR_WEBHOOK_SECRET_PREVIOUS` to the old value while the processor changes over (both
  verify), then remove it.
- `/metrics` can be protected with `METRICS_TOKEN`; keep it off the public network regardless.

## Known gaps, by design

- **No rate limiting.** 256-bit secrets cannot be guessed, so a limiter would mostly cut noise. Put one at the proxy or gateway (and per key, not just per IP).
- **Merchant signing secrets are stored in plaintext** (they must be, to sign). Encryption at rest or a KMS-held key is the next step.
- **No overlap window when rotating a merchant's signing secret**: the old secret stops signing immediately. Signing with both for a while (as Stripe does) is a good extension.
- **Keys have no scopes.** Every key can do everything a merchant can. Read-only keys are a natural next feature.
- **No audit trail** of who changed a webhook endpoint beyond the log lines (`merchant 12 changed its webhook endpoint (host …)`; the URL path and query are not logged because they can carry tokens).
- **The TOCTOU between our DNS answer and the merchant's server is closed, but a merchant's *own* DNS can still point a public name at a public host we do not expect.** That is not an SSRF; it is their server.
- **Admin is a CLI with database access.** There is no admin API or UI.

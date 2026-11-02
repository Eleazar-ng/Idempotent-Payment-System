import type { Kysely } from 'kysely';
import { generateApiKey, hashApiKey, hashesEqual, parseApiKey } from '@app/payments-core';
import type { ApiKey, Database } from './database.types';

export interface CreatedApiKey {
  id: number;
  prefix: string;
  /** The full key. This is the only time it exists in readable form: show it to the merchant and drop it. */
  key: string;
}

export async function createApiKey(
  db: Kysely<Database>,
  input: { merchantId: number; name: string; expiresAt?: Date | null },
): Promise<CreatedApiKey> {
  const generated = generateApiKey();
  const row = await db
    .insertInto('api_keys')
    .values({
      merchant_id: input.merchantId,
      name: input.name,
      key_prefix: generated.prefix,
      key_hash: generated.hash,
      expires_at: input.expiresAt ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, prefix: generated.prefix, key: generated.key };
}

export type AuthResult =
  | { ok: true; merchantId: number; keyId: number; prefix: string }
  /**
   * `reason` is for OUR logs and metrics only. The caller gets one answer for all of them, because telling a stranger
   * "that prefix exists but the secret is wrong" is how prefixes get enumerated.
   */
  | { ok: false; reason: 'malformed' | 'unknown' | 'wrong_secret' | 'revoked' | 'expired'; prefix?: string };

/** A hash no real key has, compared against when the prefix is unknown so that "no such key" costs the same as "wrong secret". */
const DUMMY_HASH = hashApiKey('pk_000000000000_no-such-key-exists-in-this-database-x');
const TOUCH_EVERY_MS = 60_000;

/**
 * Checks a presented key.
 *
 * Order of work: the shape is checked before the database is asked anything; the hash comparison is constant-time and runs even
 * for an unknown prefix; revocation and expiry are checked only after the secret matched (so a stranger cannot learn which
 * prefixes are revoked); and `last_used_at` is written at most once a minute per key and never makes a request fail.
 */
export async function authenticateApiKey(db: Kysely<Database>, presented: unknown, now: Date = new Date()): Promise<AuthResult> {
  const parsed = parseApiKey(presented);
  if (!parsed) return { ok: false, reason: 'malformed' };

  const row = await db
    .selectFrom('api_keys')
    .select(['id', 'merchant_id', 'key_hash', 'expires_at', 'revoked_at', 'last_used_at'])
    .where('key_prefix', '=', parsed.prefix)
    .executeTakeFirst();

  const matches = hashesEqual(hashApiKey(presented as string), row?.key_hash ?? DUMMY_HASH);
  if (!row) return { ok: false, reason: 'unknown', prefix: parsed.prefix };
  if (!matches) return { ok: false, reason: 'wrong_secret', prefix: parsed.prefix };
  if (row.revoked_at !== null) return { ok: false, reason: 'revoked', prefix: parsed.prefix };
  if (row.expires_at !== null && row.expires_at.getTime() <= now.getTime()) return { ok: false, reason: 'expired', prefix: parsed.prefix };

  if (row.last_used_at === null || now.getTime() - row.last_used_at.getTime() >= TOUCH_EVERY_MS) {
    // Awaited, but its failure is swallowed: a bookkeeping column must never turn a valid request into an error.
    await db
      .updateTable('api_keys')
      .set({ last_used_at: now })
      .where('id', '=', row.id)
      .where((eb) => eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<', new Date(now.getTime() - TOUCH_EVERY_MS))]))
      .execute()
      .catch(() => undefined);
  }
  return { ok: true, merchantId: row.merchant_id, keyId: row.id, prefix: parsed.prefix };
}

/** Ends a key for good. Returns false if there was no such key or it was already revoked. */
export async function revokeApiKey(db: Kysely<Database>, prefix: string, now: Date = new Date()): Promise<boolean> {
  const r = await db
    .updateTable('api_keys')
    .set({ revoked_at: now })
    .where('key_prefix', '=', prefix)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) === 1;
}

/** A merchant's keys, newest first. Never includes the hash. */
export async function listApiKeys(db: Kysely<Database>, merchantId: number): Promise<Omit<ApiKey, 'key_hash'>[]> {
  return db
    .selectFrom('api_keys')
    .select(['id', 'merchant_id', 'name', 'key_prefix', 'created_at', 'expires_at', 'last_used_at', 'revoked_at'])
    .where('merchant_id', '=', merchantId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
}

export async function createMerchantWithKey(
  db: Kysely<Database>,
  input: { name: string; keyName?: string },
): Promise<{ merchantId: number; key: CreatedApiKey }> {
  return db.transaction().execute(async (trx) => {
    const merchant = await trx.insertInto('merchants').values({ name: input.name }).returning('id').executeTakeFirstOrThrow();
    const key = await createApiKey(trx, { merchantId: merchant.id, name: input.keyName ?? 'default' });
    return { merchantId: merchant.id, key };
  });
}

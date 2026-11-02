import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API keys look like `pk_<prefix>_<secret>`:
 *
 *   prefix  12 hex characters, random, public. Finds the row, and is the only part ever logged or shown again.
 *   secret  32 random bytes (256 bits), base64url. Shown once, at creation, and never stored.
 *
 * Only a SHA-256 of the whole key is stored. A password hash (bcrypt, argon2) is deliberately NOT used: those exist to
 * slow down guessing of low-entropy human passwords, and a 256-bit random secret cannot be guessed at any speed.
 * A fast hash keeps authentication cheap on every request and is still one-way, so a leaked table is not a leaked key.
 */
export const API_KEY_PREFIX_LENGTH = 12;
const KEY_SHAPE = /^pk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

export interface GeneratedApiKey {
  /** The full key. Show it to the merchant once. */
  key: string;
  prefix: string;
  hash: string;
}

export function generateApiKey(random: (n: number) => Buffer = randomBytes): GeneratedApiKey {
  const prefix = random(API_KEY_PREFIX_LENGTH / 2).toString('hex');
  const secret = random(32).toString('base64url');
  const key = `pk_${prefix}_${secret}`;
  return { key, prefix, hash: hashApiKey(key) };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** The prefix of a well-formed key, or undefined. Checked BEFORE the database is asked anything. */
export function parseApiKey(raw: unknown): { prefix: string } | undefined {
  if (typeof raw !== 'string' || raw.length > 128) return undefined;
  const match = KEY_SHAPE.exec(raw);
  return match ? { prefix: match[1] } : undefined;
}

/** Compares two hex hashes in constant time, so response time does not reveal how many leading characters matched. */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The token from `Authorization: Bearer <token>`. Scheme is case-insensitive (RFC 7235); exactly one token. */
export function extractBearer(header: unknown): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^bearer ([^\s]+)$/i.exec(header);
  return match ? match[1] : undefined;
}

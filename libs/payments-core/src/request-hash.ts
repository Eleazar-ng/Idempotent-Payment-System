import { createHash } from 'node:crypto';
import { canonicalize } from './canonical-json';
import { UnknownHashVersionError } from './errors';

/**
 * What an idempotency key is bound to: the operation (e.g. "POST /v1/payments") AND the body.
 * Binding the operation means one key cannot be replayed against a different endpoint that
 * happens to accept the same body.
 */
export interface RequestFingerprint {
  operation: string;
  body: unknown;
}

export type HashFunction = (fingerprint: RequestFingerprint) => string;

/** What gets stored next to the key: the hash and the version of the function that produced it. */
export interface StoredHash {
  hash: string;
  version: number;
}

export interface RequestHasher {
  readonly currentVersion: number;
  /** Hash a new request with the current version. */
  hash(fingerprint: RequestFingerprint): StoredHash;
  /**
   * Does a request match a hash stored earlier? Uses the version recorded WITH the stored hash, not
   * the current one, so changing the hash function never turns an in-flight client's retry into a
   * false "payload mismatch" (Module 11.3).
   */
  matches(stored: StoredHash, fingerprint: RequestFingerprint): boolean;
}

export interface RequestHasherConfig {
  /** Every version ever written to the database must stay here, forever. */
  versions: Readonly<Record<number, HashFunction>>;
  current: number;
}

export function createRequestHasher(config: RequestHasherConfig): RequestHasher {
  const lookup = (version: number): HashFunction => {
    const fn = config.versions[version];
    if (!fn) throw new UnknownHashVersionError(version);
    return fn;
  };
  lookup(config.current); // fail at startup, not on the first request

  return {
    currentVersion: config.current,
    hash: (fingerprint) => ({ hash: lookup(config.current)(fingerprint), version: config.current }),
    matches: (stored, fingerprint) => lookup(stored.version)(fingerprint) === stored.hash,
  };
}

/**
 * Version 1: sha256 over the canonical JSON of { operation, body }, hex encoded.
 *
 * NEVER edit this function once rows exist that were hashed with it: add version 2 beside it. A
 * known-answer test pins the exact output so an accidental change fails the build.
 */
export const hashV1: HashFunction = ({ operation, body }) => {
  if (typeof operation !== 'string' || operation.length === 0) {
    throw new TypeError('request fingerprint needs a non-empty operation');
  }
  return createHash('sha256').update(canonicalize({ operation, body })).digest('hex');
};

export const requestHasher: RequestHasher = createRequestHasher({
  versions: { 1: hashV1 },
  current: 1,
});

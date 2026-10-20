import { UnknownHashVersionError } from './errors';
import { createRequestHasher, hashV1, requestHasher } from './request-hash';
import type { RequestFingerprint } from './request-hash';

const payment: RequestFingerprint = {
  operation: 'POST /v1/payments',
  body: { order_id: 'ord_1', amount: 5000, currency: 'NGN', metadata: { z: null, a: [1, 2] } },
};

describe('hashV1', () => {
  it('matches a known answer, so any accidental change to version 1 fails the build', () => {
    // Computed independently, from a hand-written canonical string:
    //   sha256('{"body":{"amount":5000,"currency":"NGN","metadata":{"a":[1,2],"z":null},"order_id":"ord_1"},"operation":"POST /v1/payments"}')
    // Rows hashed this way already exist in production databases, so this value must never change
    // (add version 2 instead, Module 11.3).
    expect(hashV1(payment)).toBe('82073a6d33f6d97fe8263a064d644b20f9ecf38fb9d95fd3682ca74fb71c09a1');
  });

  it('is a 64-character lowercase hex digest', () => {
    expect(hashV1(payment)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores key order and formatting of the body', () => {
    const reordered: RequestFingerprint = {
      operation: 'POST /v1/payments',
      body: { metadata: { a: [1, 2], z: null }, currency: 'NGN', amount: 5000, order_id: 'ord_1' },
    };
    expect(hashV1(reordered)).toBe(hashV1(payment));
  });

  it.each([
    ['a different amount', { ...(payment.body as object), amount: 5001 }],
    ['a different currency', { ...(payment.body as object), currency: 'USD' }],
    ['an amount as a string', { ...(payment.body as object), amount: '5000' }],
    ['an extra field', { ...(payment.body as object), note: 'x' }],
    ['a missing field', { order_id: 'ord_1', amount: 5000, currency: 'NGN' }],
    ['reordered array items', { ...(payment.body as object), metadata: { z: null, a: [2, 1] } }],
  ])('changes when the body has %s', (_name, body) => {
    expect(hashV1({ operation: payment.operation, body })).not.toBe(hashV1(payment));
  });

  it('is bound to the operation, so one key cannot be replayed against another endpoint', () => {
    expect(hashV1({ operation: 'POST /v1/refunds', body: payment.body })).not.toBe(hashV1(payment));
  });

  it('cannot be confused by moving content between operation and body', () => {
    const a = hashV1({ operation: 'x', body: { operation: 'y' } });
    const b = hashV1({ operation: 'y', body: { operation: 'x' } });
    expect(a).not.toBe(b);
  });

  it('refuses a missing operation or a non-canonical body instead of hashing something else', () => {
    expect(() => hashV1({ operation: '', body: {} })).toThrow(TypeError);
    expect(() => hashV1({ operation: 'op', body: { a: undefined } })).toThrow();
  });
});

describe('requestHasher (versioning, Module 11.3)', () => {
  it('hashes with the current version and says which it was', () => {
    expect(requestHasher.hash(payment)).toEqual({ hash: hashV1(payment), version: 1 });
  });

  it('recognises the same request and rejects a different one', () => {
    const stored = requestHasher.hash(payment);
    expect(requestHasher.matches(stored, payment)).toBe(true);
    expect(requestHasher.matches(stored, { ...payment, body: { order_id: 'other' } })).toBe(false);
  });

  describe('after the hash function is changed', () => {
    // Version 2 hashes a different way (here: it ignores `metadata`), as a stand-in for any change.
    const hashV2 = (fp: RequestFingerprint) => {
      const { metadata: _ignored, ...rest } = fp.body as Record<string, unknown>;
      return `v2:${hashV1({ operation: fp.operation, body: rest })}`;
    };

    const upgraded = createRequestHasher({ versions: { 1: hashV1, 2: hashV2 }, current: 2 });

    it('hashes new requests with the new version', () => {
      const fresh = upgraded.hash(payment);
      expect(fresh.version).toBe(2);
      expect(fresh.hash.startsWith('v2:')).toBe(true);
    });

    it('still recognises a retry whose key was stored under version 1', () => {
      const storedBeforeUpgrade = requestHasher.hash(payment); // version 1
      expect(upgraded.matches(storedBeforeUpgrade, payment)).toBe(true);
    });

    it('still rejects a different payload against a version 1 row', () => {
      const storedBeforeUpgrade = requestHasher.hash(payment);
      expect(upgraded.matches(storedBeforeUpgrade, { ...payment, body: { order_id: 'ord_2' } })).toBe(false);
    });

    it('would wrongly reject that retry if the stored version were ignored (what this design prevents)', () => {
      const storedBeforeUpgrade = requestHasher.hash(payment);
      const naive = upgraded.hash(payment).hash === storedBeforeUpgrade.hash;
      expect(naive).toBe(false);
    });
  });

  it('refuses to start with a current version it has no function for', () => {
    expect(() => createRequestHasher({ versions: { 1: hashV1 }, current: 2 })).toThrow(UnknownHashVersionError);
  });

  it('fails loudly, rather than guessing, on a stored row with an unknown version', () => {
    expect(() => requestHasher.matches({ hash: 'abc', version: 99 }, payment)).toThrow(UnknownHashVersionError);
  });
});

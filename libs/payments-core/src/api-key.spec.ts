import { extractBearer, generateApiKey, hashApiKey, hashesEqual, parseApiKey } from './api-key';

describe('api keys', () => {
  it('generates a key of the documented shape, with a prefix that parses back out', () => {
    const { key, prefix, hash } = generateApiKey();
    expect(key).toMatch(/^pk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(parseApiKey(key)).toEqual({ prefix });
    expect(hash).toBe(hashApiKey(key));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never repeats', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
    expect(keys.size).toBe(200);
  });

  it('does not put the secret in the hash input of another key', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.hash).not.toBe(b.hash);
    expect(hashApiKey(a.key)).not.toBe(hashApiKey(`${a.key} `));
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'pk_',
    'sk_aaaaaaaaaaaa_' + 'A'.repeat(43),
    'pk_AAAAAAAAAAAA_' + 'A'.repeat(43), // uppercase hex prefix
    'pk_aaaaaaaaaaaa_' + 'A'.repeat(42), // short secret
    'pk_aaaaaaaaaaaa_' + 'A'.repeat(44), // long secret
    'pk_aaaaaaaaaaaa_' + 'A'.repeat(42) + '!',
    'pk_aaaaaaaaaaaa_' + 'A'.repeat(43) + '\n',
    'x'.repeat(5000),
  ])('refuses a malformed key before any lookup: %p', (raw) => {
    expect(parseApiKey(raw)).toBeUndefined();
  });

  it('compares hashes without caring where they differ', () => {
    const h = hashApiKey('a');
    expect(hashesEqual(h, h)).toBe(true);
    expect(hashesEqual(h, hashApiKey('b'))).toBe(false);
    expect(hashesEqual(h, h.slice(1))).toBe(false);
    expect(hashesEqual(h, '')).toBe(false);
  });

  it.each([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['BEARER abc', 'abc'],
  ])('reads the token from %p', (header, token) => {
    expect(extractBearer(header)).toBe(token);
  });

  it.each([undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'Bearer a b', 'Bearer  abc', 'Token abc', ['Bearer abc'], 5])(
    'finds no token in %p',
    (header) => {
      expect(extractBearer(header)).toBeUndefined();
    },
  );
});

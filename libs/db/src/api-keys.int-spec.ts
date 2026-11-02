import { createMerchant, startMigratedPostgres, TestPostgres } from '@app/testing';
import { authenticateApiKey, createApiKey, createMerchantWithKey, listApiKeys, revokeApiKey } from './api-keys';

describe('api keys (real Postgres)', () => {
  let pg: TestPostgres;
  let merchantId: number;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
  });
  afterAll(async () => {
    await pg?.stop();
  });
  beforeEach(async () => {
    merchantId = await createMerchant(pg.db);
  });

  const row = (id: number) => pg.db.selectFrom('api_keys').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  it('authenticates a fresh key as its merchant', async () => {
    const { key, id, prefix } = await createApiKey(pg.db, { merchantId, name: 'server' });
    expect(await authenticateApiKey(pg.db, key)).toEqual({ ok: true, merchantId, keyId: id, prefix });
  });

  it('stores a hash, never the key', async () => {
    const { key, id } = await createApiKey(pg.db, { merchantId, name: 'server' });
    const stored = await row(id);
    expect(JSON.stringify(stored)).not.toContain(key.split('_')[2]); // the secret part appears nowhere in the row
    expect(stored.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives ONE answer for every way of being wrong', async () => {
    const { key, prefix } = await createApiKey(pg.db, { merchantId, name: 'server' });
    const wrongSecret = `pk_${prefix}_${'A'.repeat(43)}`;
    const unknownPrefix = `pk_${'0'.repeat(12)}_${'A'.repeat(43)}`;
    for (const bad of [wrongSecret, unknownPrefix, 'garbage', '', undefined, null, `${key} `, key.toUpperCase(), key.slice(0, -1)]) {
      expect((await authenticateApiKey(pg.db, bad)).ok).toBe(false);
    }
    expect((await authenticateApiKey(pg.db, key)).ok).toBe(true);
  });

  it('says why, for the logs: malformed, unknown, wrong secret, revoked, expired', async () => {
    const { key, prefix } = await createApiKey(pg.db, { merchantId, name: 'server' });
    expect(await authenticateApiKey(pg.db, 'garbage')).toEqual({ ok: false, reason: 'malformed' });
    expect(await authenticateApiKey(pg.db, `pk_${'0'.repeat(12)}_${'A'.repeat(43)}`)).toEqual({ ok: false, reason: 'unknown', prefix: '0'.repeat(12) });
    expect(await authenticateApiKey(pg.db, `pk_${prefix}_${'A'.repeat(43)}`)).toEqual({ ok: false, reason: 'wrong_secret', prefix });
    const timed = await createApiKey(pg.db, { merchantId, name: 'timed', expiresAt: new Date(Date.now() + 60_000) });
    expect(await authenticateApiKey(pg.db, timed.key, new Date(Date.now() + 120_000))).toEqual({ ok: false, reason: 'expired', prefix: timed.prefix });
    await revokeApiKey(pg.db, prefix);
    expect(await authenticateApiKey(pg.db, key)).toEqual({ ok: false, reason: 'revoked', prefix });
  });

  it('does not reveal revocation to someone who does not hold the secret', async () => {
    const { prefix } = await createApiKey(pg.db, { merchantId, name: 'server' });
    await revokeApiKey(pg.db, prefix);
    expect(await authenticateApiKey(pg.db, `pk_${prefix}_${'A'.repeat(43)}`)).toEqual({ ok: false, reason: 'wrong_secret', prefix });
  });

  it('refuses a key once revoked, and revoking twice says so', async () => {
    const { key, prefix } = await createApiKey(pg.db, { merchantId, name: 'old' });
    expect(await revokeApiKey(pg.db, prefix)).toBe(true);
    expect((await authenticateApiKey(pg.db, key)).ok).toBe(false);
    expect(await revokeApiKey(pg.db, prefix)).toBe(false);
    expect(await revokeApiKey(pg.db, '0'.repeat(12))).toBe(false);
  });

  it('refuses a key at and after its expiry, and accepts it before', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    const { key } = await createApiKey(pg.db, { merchantId, name: 'short', expiresAt });
    expect((await authenticateApiKey(pg.db, key, new Date(expiresAt.getTime() - 1))).ok).toBe(true);
    expect((await authenticateApiKey(pg.db, key, expiresAt)).ok).toBe(false);
    expect((await authenticateApiKey(pg.db, key, new Date(expiresAt.getTime() + 1))).ok).toBe(false);
  });

  it('rotation: two keys work at once, and revoking the old one leaves the new one alone', async () => {
    const oldKey = await createApiKey(pg.db, { merchantId, name: 'old' });
    const newKey = await createApiKey(pg.db, { merchantId, name: 'new' });
    expect((await authenticateApiKey(pg.db, oldKey.key)).ok).toBe(true);
    expect((await authenticateApiKey(pg.db, newKey.key)).ok).toBe(true);
    await revokeApiKey(pg.db, oldKey.prefix);
    expect((await authenticateApiKey(pg.db, oldKey.key)).ok).toBe(false);
    expect(await authenticateApiKey(pg.db, newKey.key)).toEqual({ ok: true, merchantId, keyId: newKey.id, prefix: newKey.prefix });
  });

  it('keys of different merchants resolve to their own merchant', async () => {
    const other = await createMerchant(pg.db);
    const a = await createApiKey(pg.db, { merchantId, name: 'a' });
    const b = await createApiKey(pg.db, { merchantId: other, name: 'b' });
    expect(await authenticateApiKey(pg.db, a.key)).toMatchObject({ ok: true, merchantId });
    expect(await authenticateApiKey(pg.db, b.key)).toMatchObject({ ok: true, merchantId: other });
  });

  it('records last use at most once a minute', async () => {
    const { key, id } = await createApiKey(pg.db, { merchantId, name: 'server' });
    expect((await row(id)).last_used_at).toBeNull();

    const t0 = new Date(Date.now() + 1000);
    await authenticateApiKey(pg.db, key, t0);
    expect((await row(id)).last_used_at).toEqual(t0);

    await authenticateApiKey(pg.db, key, new Date(t0.getTime() + 30_000)); // inside the minute: no write
    expect((await row(id)).last_used_at).toEqual(t0);

    const t2 = new Date(t0.getTime() + 61_000);
    await authenticateApiKey(pg.db, key, t2);
    expect((await row(id)).last_used_at).toEqual(t2);
  });

  it('lists keys without their hashes, newest first', async () => {
    const a = await createApiKey(pg.db, { merchantId, name: 'first' });
    const b = await createApiKey(pg.db, { merchantId, name: 'second' });
    const listed = await listApiKeys(pg.db, merchantId);
    expect(listed.map((k) => k.key_prefix)).toEqual([b.prefix, a.prefix]);
    expect(JSON.stringify(listed)).not.toContain('key_hash');
  });

  it('creates a merchant and its first key together, or neither', async () => {
    const { merchantId: id, key } = await createMerchantWithKey(pg.db, { name: `m-${Date.now()}` });
    expect(await authenticateApiKey(pg.db, key.key)).toMatchObject({ ok: true, merchantId: id });
  });
});

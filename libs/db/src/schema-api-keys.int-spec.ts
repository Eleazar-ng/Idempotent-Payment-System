import { hashApiKey } from '@app/payments-core';
import { createMerchant, expectSqlState, PG, startMigratedPostgres, TestPostgres, uid } from '@app/testing';

describe('0010 api_keys schema', () => {
  let pg: TestPostgres;
  let merchantId: number;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    merchantId = await createMerchant(pg.db);
  });

  afterAll(async () => {
    await pg?.stop();
  });

  const prefix = () => Array.from({ length: 12 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const insert = (over: Record<string, unknown> = {}) =>
    pg.db
      .insertInto('api_keys')
      .values({ merchant_id: merchantId, name: 'k', key_prefix: prefix(), key_hash: hashApiKey(uid()), ...over })
      .returning(['id', 'key_prefix'])
      .executeTakeFirstOrThrow();
  const update = (id: number, set: Record<string, unknown>) => pg.db.updateTable('api_keys').set(set).where('id', '=', id).execute();

  it('refuses a duplicate prefix', async () => {
    const a = await insert();
    await expectSqlState(insert({ key_prefix: a.key_prefix }), PG.UNIQUE_VIOLATION);
  });

  it('refuses a prefix or hash of the wrong shape, and a blank or oversized name', async () => {
    await expectSqlState(insert({ key_prefix: 'ABCDEF012345' }), PG.CHECK_VIOLATION);
    await expectSqlState(insert({ key_prefix: 'abc' }), PG.CHECK_VIOLATION);
    await expectSqlState(insert({ key_hash: 'plaintext-key' }), PG.CHECK_VIOLATION);
    await expectSqlState(insert({ key_hash: 'A'.repeat(64) }), PG.CHECK_VIOLATION);
    await expectSqlState(insert({ name: '' }), PG.CHECK_VIOLATION);
    await expectSqlState(insert({ name: 'x'.repeat(101) }), PG.CHECK_VIOLATION);
  });

  it('refuses a key for a merchant that does not exist', async () => {
    await expectSqlState(insert({ merchant_id: 987_654_321 }), PG.FOREIGN_KEY_VIOLATION);
  });

  it('refuses an expiry in the past of its own creation', async () => {
    await expectSqlState(insert({ expires_at: new Date('2000-01-01') }), PG.CHECK_VIOLATION);
  });

  it('never lets what a key IS change: owner, prefix, hash, name, creation time, expiry', async () => {
    const a = await insert({ expires_at: new Date(Date.now() + 86_400_000) });
    const other = await createMerchant(pg.db);
    await expectSqlState(update(a.id, { merchant_id: other }), PG.IMMUTABLE_COLUMN);
    await expectSqlState(update(a.id, { key_prefix: prefix() }), PG.IMMUTABLE_COLUMN);
    await expectSqlState(update(a.id, { key_hash: hashApiKey('new') }), PG.IMMUTABLE_COLUMN);
    await expectSqlState(update(a.id, { name: 'renamed' }), PG.IMMUTABLE_COLUMN);
    await expectSqlState(update(a.id, { created_at: new Date('2000-01-01') }), PG.IMMUTABLE_COLUMN);
    await expectSqlState(update(a.id, { expires_at: new Date(Date.now() + 10 * 86_400_000) }), PG.IMMUTABLE_COLUMN); // a key cannot be quietly extended
  });

  it('allows revoking, and once revoked a key stays revoked', async () => {
    const a = await insert();
    await update(a.id, { revoked_at: new Date() });
    await expectSqlState(update(a.id, { revoked_at: null }), PG.IMMUTABLE_COLUMN);
    await expectSqlState(update(a.id, { revoked_at: new Date(Date.now() + 1000) }), PG.IMMUTABLE_COLUMN);
  });

  it('allows last_used_at to move', async () => {
    const a = await insert();
    await update(a.id, { last_used_at: new Date() });
    await update(a.id, { last_used_at: new Date(Date.now() + 1000) });
  });
});

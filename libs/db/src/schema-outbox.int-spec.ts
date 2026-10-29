import { createMerchant, expectSqlState, PG, startMigratedPostgres, TestPostgres, uid } from '../../testing/src';

describe('0008 outbox schema', () => {
  let pg: TestPostgres;
  let merchantId: number;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    merchantId = await createMerchant(pg.db);
  });

  afterAll(async () => {
    await pg?.stop();
  });

  const insert = (over: Record<string, unknown> = {}) =>
    pg.db
      .insertInto('outbox_events')
      .values({
        dedupe_key: `k_${uid()}`,
        merchant_id: merchantId,
        event_type: 'payment.succeeded',
        payload: JSON.stringify({ a: 1 }),
        ...over,
      })
      .returning(['id', 'dedupe_key'])
      .executeTakeFirstOrThrow();
  const update = (id: number, set: Record<string, unknown>) =>
    pg.db.updateTable('outbox_events').set(set).where('id', '=', id).execute();

  describe('merchants.webhook_*', () => {
    const set = (values: Record<string, unknown>) =>
      pg.db.updateTable('merchants').set(values).where('id', '=', merchantId).execute();

    it('accepts a URL with a secret, or neither', async () => {
      await set({ webhook_url: 'https://shop.example/hooks', webhook_secret: 'a-long-enough-secret' });
      await set({ webhook_url: null, webhook_secret: null });
    });

    it('refuses a URL without a secret and a secret without a URL', async () => {
      await expectSqlState(set({ webhook_url: 'https://shop.example/hooks' }), PG.CHECK_VIOLATION);
      await expectSqlState(set({ webhook_secret: 'a-long-enough-secret' }), PG.CHECK_VIOLATION);
    });

    it.each(['ftp://x.example', 'shop.example/hook', 'https://has space.example', ''])('refuses the URL %j', async (url) => {
      await expectSqlState(set({ webhook_url: url, webhook_secret: 'a-long-enough-secret' }), PG.CHECK_VIOLATION);
    });

    it('refuses a short secret', async () => {
      await expectSqlState(set({ webhook_url: 'https://shop.example/h', webhook_secret: 'short' }), PG.CHECK_VIOLATION);
    });
  });

  it('refuses the same dedupe key twice', async () => {
    const first = await insert();
    await expectSqlState(insert({ dedupe_key: first.dedupe_key }), PG.UNIQUE_VIOLATION);
  });

  it('refuses an unknown merchant and an unknown status', async () => {
    await expectSqlState(insert({ merchant_id: 987_654_321 }), PG.FOREIGN_KEY_VIOLATION);
    await expectSqlState(insert({ status: 'sent' }), PG.CHECK_VIOLATION);
  });

  it('refuses negative attempts', async () => {
    await expectSqlState(insert({ attempts: -1 }), PG.CHECK_VIOLATION);
  });

  it('delivered needs a delivery time, and only delivered has one', async () => {
    const a = await insert();
    await expectSqlState(update(a.id, { status: 'delivered' }), PG.CHECK_VIOLATION);
    const b = await insert();
    await expectSqlState(update(b.id, { delivered_at: new Date() }), PG.CHECK_VIOLATION);
  });

  it('dead must say why', async () => {
    const a = await insert();
    await expectSqlState(update(a.id, { status: 'dead' }), PG.CHECK_VIOLATION);
    await update(a.id, { status: 'dead', last_error: 'http_500' });
  });

  it.each(['dedupe_key', 'event_type'])('what the event says never changes: %s', async (column) => {
    const { id } = await insert();
    await expectSqlState(update(id, { [column]: 'changed' }), PG.IMMUTABLE_COLUMN);
  });

  it('the payload and merchant never change', async () => {
    const { id } = await insert();
    const other = await createMerchant(pg.db);
    await expectSqlState(update(id, { payload: JSON.stringify({ a: 2 }) }), PG.IMMUTABLE_COLUMN);
    await expectSqlState(update(id, { merchant_id: other }), PG.IMMUTABLE_COLUMN);
  });

  it.each([
    ['delivered', { status: 'delivered', delivered_at: new Date() }],
    ['skipped', { status: 'skipped', last_error: 'no_webhook_url' }],
  ])('%s is final', async (_name, set) => {
    const { id } = await insert();
    await update(id, set);
    await expectSqlState(update(id, { last_error: 'again' }), PG.APPEND_ONLY);
  });

  it('dead is not final: it can go back to pending', async () => {
    const { id } = await insert();
    await update(id, { status: 'dead', last_error: 'http_500' });
    await update(id, { status: 'pending', attempts: 0 });
  });

  it('can be deleted, so retention cleanup works', async () => {
    const { id } = await insert();
    await pg.db.deleteFrom('outbox_events').where('id', '=', id).execute();
  });
});

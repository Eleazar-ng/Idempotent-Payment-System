import { sql } from 'kysely';
import {
  advanceAttemptTo,
  createAttempt,
  createIntent,
  createMerchant,
  expectSqlState,
  PG,
  startMigratedPostgres,
  TestPostgres,
  uid,
} from '../../testing/src';

/** Stage 1.1: the core tables, their basic constraints, and the helper triggers. */
describe('schema: core tables (0001)', () => {
  let pg: TestPostgres;
  let merchantId: number;

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    merchantId = await createMerchant(pg.db);
  });

  afterAll(async () => {
    await pg?.stop();
  });

  describe('payment_intents', () => {
    it('applies defaults: status open and timestamps set', async () => {
      const id = await createIntent(pg.db, merchantId);

      const row = await pg.db.selectFrom('payment_intents').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

      expect(row.status).toBe('open');
      expect(row.created_at).toBeInstanceOf(Date);
      expect(row.updated_at).toBeInstanceOf(Date);
    });

    it.each([0, -1, -5000])('rejects a non-positive amount (%d)', async (amount) => {
      await expectSqlState(createIntent(pg.db, merchantId, { amount }), PG.CHECK_VIOLATION);
    });

    it.each(['ngn', 'NG', 'NGNN', 'N1N', ''])('rejects the malformed currency "%s"', async (currency) => {
      await expectSqlState(createIntent(pg.db, merchantId, { currency }), PG.CHECK_VIOLATION);
    });

    it('rejects an empty order id', async () => {
      await expectSqlState(createIntent(pg.db, merchantId, { orderId: '' }), PG.CHECK_VIOLATION);
    });

    it('rejects an unknown merchant', async () => {
      await expectSqlState(createIntent(pg.db, 999_999_999), PG.FOREIGN_KEY_VIOLATION);
    });

    it('allows only one intent per order per merchant', async () => {
      const orderId = `order-${uid()}`;
      await createIntent(pg.db, merchantId, { orderId });

      await expectSqlState(
        createIntent(pg.db, merchantId, { orderId }),
        PG.UNIQUE_VIOLATION,
        /payment_intents_one_per_order/,
      );
    });

    it('lets different merchants use the same order id', async () => {
      const orderId = `order-${uid()}`;
      const other = await createMerchant(pg.db);

      await createIntent(pg.db, merchantId, { orderId });
      await expect(createIntent(pg.db, other, { orderId })).resolves.toEqual(expect.any(Number));
    });

    it.each([
      ['amount', { amount: 9999 }],
      ['currency', { currency: 'USD' }],
      ['order_id', { order_id: 'a-different-order' }],
    ])('refuses to change the %s once created', async (_column, change) => {
      const id = await createIntent(pg.db, merchantId);

      await expectSqlState(
        pg.db.updateTable('payment_intents').set(change).where('id', '=', id).execute(),
        PG.IMMUTABLE_COLUMN,
      );
    });

    it('refuses to move an intent to another merchant', async () => {
      const id = await createIntent(pg.db, merchantId);
      const other = await createMerchant(pg.db);

      await expectSqlState(
        pg.db.updateTable('payment_intents').set({ merchant_id: other }).where('id', '=', id).execute(),
        PG.IMMUTABLE_COLUMN,
      );
    });

    it('bumps updated_at on every update without the caller asking', async () => {
      const id = await createIntent(pg.db, merchantId);
      const before = await pg.db.selectFrom('payment_intents').select('updated_at').where('id', '=', id).executeTakeFirstOrThrow();

      await pg.db.updateTable('payment_intents').set({ status: 'canceled' }).where('id', '=', id).execute();

      const after = await pg.db.selectFrom('payment_intents').select('updated_at').where('id', '=', id).executeTakeFirstOrThrow();
      expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    });
  });

  describe('payment_attempts', () => {
    it('enforces one attempt number per intent, even after the earlier attempt failed', async () => {
      const intentId = await createIntent(pg.db, merchantId);
      const first = await createAttempt(pg.db, intentId, 1);
      await advanceAttemptTo(pg.db, first, 'failed');

      await expectSqlState(createAttempt(pg.db, intentId, 1), PG.UNIQUE_VIOLATION, /payment_attempts_number_per_intent/);
    });

    it.each([0, -1])('rejects attempt number %d', async (attemptNumber) => {
      const intentId = await createIntent(pg.db, merchantId);
      await expectSqlState(createAttempt(pg.db, intentId, attemptNumber), PG.CHECK_VIOLATION);
    });

    it('requires processor idempotency keys to be unique across all merchants and intents', async () => {
      const key = `shared-key-${uid()}`;
      const intentA = await createIntent(pg.db, merchantId);
      const intentB = await createIntent(pg.db, await createMerchant(pg.db));

      await pg.db
        .insertInto('payment_attempts')
        .values({ payment_intent_id: intentA, attempt_number: 1, processor_idempotency_key: key })
        .execute();

      await expectSqlState(
        pg.db
          .insertInto('payment_attempts')
          .values({ payment_intent_id: intentB, attempt_number: 1, processor_idempotency_key: key })
          .execute(),
        PG.UNIQUE_VIOLATION,
        /payment_attempts_processor_key_unique/,
      );
    });

    it('rejects an empty processor idempotency key', async () => {
      const intentId = await createIntent(pg.db, merchantId);
      await expectSqlState(
        pg.db
          .insertInto('payment_attempts')
          .values({ payment_intent_id: intentId, attempt_number: 1, processor_idempotency_key: '' })
          .execute(),
        PG.CHECK_VIOLATION,
      );
    });

    it.each([
      ['processor_idempotency_key', { processor_idempotency_key: 'a-different-key' }],
      ['attempt_number', { attempt_number: 2 }],
    ])('refuses to change %s, because retries depend on it staying the same', async (_column, change) => {
      const attemptId = await createAttempt(pg.db, await createIntent(pg.db, merchantId));

      await expectSqlState(
        pg.db.updateTable('payment_attempts').set(change).where('id', '=', attemptId).execute(),
        PG.IMMUTABLE_COLUMN,
      );
    });

    it('refuses to move an attempt to another intent', async () => {
      const attemptId = await createAttempt(pg.db, await createIntent(pg.db, merchantId));
      const otherIntent = await createIntent(pg.db, merchantId);

      await expectSqlState(
        pg.db.updateTable('payment_attempts').set({ payment_intent_id: otherIntent }).where('id', '=', attemptId).execute(),
        PG.IMMUTABLE_COLUMN,
      );
    });

    it('lets the processor charge id be set once, then never re-pointed', async () => {
      const attemptId = await createAttempt(pg.db, await createIntent(pg.db, merchantId));
      const set = (chargeId: string) =>
        pg.db.updateTable('payment_attempts').set({ processor_charge_id: chargeId }).where('id', '=', attemptId).execute();

      await set('ch_first');
      await expect(set('ch_first')).resolves.toBeDefined(); // same value: harmless
      await expectSqlState(set('ch_second'), PG.IMMUTABLE_COLUMN, /write-once/);
    });

    it('never attaches one processor charge to two attempts', async () => {
      const a = await createAttempt(pg.db, await createIntent(pg.db, merchantId));
      const b = await createAttempt(pg.db, await createIntent(pg.db, merchantId));
      const chargeId = `ch_${uid()}`;

      await pg.db.updateTable('payment_attempts').set({ processor_charge_id: chargeId }).where('id', '=', a).execute();

      await expectSqlState(
        pg.db.updateTable('payment_attempts').set({ processor_charge_id: chargeId }).where('id', '=', b).execute(),
        PG.UNIQUE_VIOLATION,
        /payment_attempts_charge_unique/,
      );
    });

    it('rejects a succeeded attempt that has no processor charge id', async () => {
      const attemptId = await createAttempt(pg.db, await createIntent(pg.db, merchantId));
      await advanceAttemptTo(pg.db, attemptId, 'calling_processor');

      await expectSqlState(
        pg.db.updateTable('payment_attempts').set({ status: 'succeeded' }).where('id', '=', attemptId).execute(),
        PG.CHECK_VIOLATION,
        /payment_attempts_succeeded_has_charge/,
      );
    });

    it('rejects a failed attempt that gives no reason', async () => {
      const attemptId = await createAttempt(pg.db, await createIntent(pg.db, merchantId));
      await advanceAttemptTo(pg.db, attemptId, 'calling_processor');

      await expectSqlState(
        pg.db.updateTable('payment_attempts').set({ status: 'failed' }).where('id', '=', attemptId).execute(),
        PG.CHECK_VIOLATION,
        /payment_attempts_failed_has_reason/,
      );
    });
  });

  describe('idempotency_keys', () => {
    const claim = (merchant: number, key: string, hash = 'hash-a') =>
      pg.db
        .insertInto('idempotency_keys')
        .values({ merchant_id: merchant, idempotency_key: key, request_hash: hash })
        .onConflict((oc) => oc.columns(['merchant_id', 'idempotency_key']).doNothing())
        .returningAll()
        .executeTakeFirst();

    it('is an atomic claim: the first insert wins and a repeat is a no-op', async () => {
      const key = `key-${uid()}`;

      const first = await claim(merchantId, key);
      const second = await claim(merchantId, key);

      expect(first).toBeDefined();
      expect(first?.completed_at).toBeNull();
      expect(first?.hash_version).toBe(1);
      expect(second).toBeUndefined();
    });

    it('scopes keys per merchant, so unrelated merchants cannot collide', async () => {
      const key = `key-${uid()}`;
      const other = await createMerchant(pg.db);

      expect(await claim(merchantId, key)).toBeDefined();
      expect(await claim(other, key)).toBeDefined();
    });

    it('rejects an empty key or an empty request hash', async () => {
      await expectSqlState(claim(merchantId, ''), PG.CHECK_VIOLATION);
      await expectSqlState(claim(merchantId, `key-${uid()}`, ''), PG.CHECK_VIOLATION);
    });

    it('has exactly one winner when many requests claim the same key at once', async () => {
      const key = `key-${uid()}`;

      const results = await Promise.all(Array.from({ length: 20 }, () => claim(merchantId, key)));

      expect(results.filter((row) => row !== undefined)).toHaveLength(1);
    });

    async function complete(key: string, status = 201, body: string | null = '{"ok":true}') {
      return pg.db
        .updateTable('idempotency_keys')
        .set({ response_status: status, response_body: body, completed_at: new Date() })
        .where('merchant_id', '=', merchantId)
        .where('idempotency_key', '=', key)
        .execute();
    }

    it('can be completed once with a response to replay', async () => {
      const key = `key-${uid()}`;
      await claim(merchantId, key);

      await complete(key, 402, '{"error":"card_declined"}');

      const row = await pg.db.selectFrom('idempotency_keys').selectAll().where('idempotency_key', '=', key).executeTakeFirstOrThrow();
      expect(row.response_status).toBe(402);
      expect(row.response_body).toEqual({ error: 'card_declined' });
      expect(row.completed_at).toBeInstanceOf(Date);
    });

    it('freezes the stored response once completed, so replays can never change', async () => {
      const key = `key-${uid()}`;
      await claim(merchantId, key);
      await complete(key);

      await expectSqlState(complete(key, 500, '{"ok":false}'), PG.APPEND_ONLY);
    });

    it('allows deleting a completed key, because expiry cleanup removes old keys', async () => {
      const key = `key-${uid()}`;
      await claim(merchantId, key);
      await complete(key);

      await pg.db.deleteFrom('idempotency_keys').where('idempotency_key', '=', key).execute();

      const rows = await pg.db.selectFrom('idempotency_keys').select('idempotency_key').where('idempotency_key', '=', key).execute();
      expect(rows).toHaveLength(0);
    });

    it('never lets a key be re-bound to a different request hash', async () => {
      const key = `key-${uid()}`;
      await claim(merchantId, key, 'original-hash');

      await expectSqlState(
        pg.db
          .updateTable('idempotency_keys')
          .set({ request_hash: 'different-hash' })
          .where('idempotency_key', '=', key)
          .execute(),
        PG.IMMUTABLE_COLUMN,
        /request_hash/,
      );
    });

    it('treats "completed" as one fact: status and completion time come together', async () => {
      const key = `key-${uid()}`;
      await claim(merchantId, key);
      const update = (values: Record<string, unknown>) =>
        pg.db.updateTable('idempotency_keys').set(values).where('idempotency_key', '=', key).execute();

      await expectSqlState(update({ completed_at: new Date() }), PG.CHECK_VIOLATION, /completion_consistent/);
      await expectSqlState(update({ response_status: 200 }), PG.CHECK_VIOLATION, /completion_consistent/);
      await expectSqlState(update({ response_body: '{"x":1}' }), PG.CHECK_VIOLATION, /body_needs_completion/);
    });

    it.each([99, 600])('rejects the impossible HTTP status %d', async (status) => {
      const key = `key-${uid()}`;
      await claim(merchantId, key);
      await expectSqlState(complete(key, status), PG.CHECK_VIOLATION);
    });

    it('can point at the attempt it created', async () => {
      const key = `key-${uid()}`;
      const attemptId = await createAttempt(pg.db, await createIntent(pg.db, merchantId));
      await claim(merchantId, key);

      await pg.db.updateTable('idempotency_keys').set({ attempt_id: attemptId }).where('idempotency_key', '=', key).execute();

      await expectSqlState(
        pg.db.updateTable('idempotency_keys').set({ attempt_id: 999_999_999 }).where('idempotency_key', '=', key).execute(),
        PG.FOREIGN_KEY_VIOLATION,
      );
    });
  });

  describe('schema basics', () => {
    it('returns bigint columns as JS numbers', async () => {
      const { rows } = await sql<{ id: unknown }>`select id from merchants limit 1`.execute(pg.db);
      expect(typeof rows[0].id).toBe('number');
    });
  });
});

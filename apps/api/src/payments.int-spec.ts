import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { checkLedgerInvariants, createDb, DB, findAttemptsMissingOutboxEvent } from '@app/db';
import type { Database } from '@app/db';
import { createMerchant, startMigratedPostgres, TestPostgres, uid } from '@app/testing';
import { FakeProcessorModule } from '../../fake-processor/src/fake-processor.module';
import { ApiModule } from './api.module';
import { PAYMENT_FLOW_OPTIONS } from './payments.service';
import { PROCESSOR_CLIENT_OPTIONS } from './processor.client';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Stage 5, end to end: the real API, a real Postgres, and the real fake processor, talking over real
 * sockets. Every Module 2 failure mode that can be provoked from outside is provoked here.
 *
 * Client timeout is 300 ms and unknown outcomes are retried twice (3 tries), so the numbers in the
 * fault rules below are chosen against those.
 */
describe('POST /v1/payments (API + Postgres + fake processor)', () => {
  let pg: TestPostgres;
  let apiDb: Kysely<Database>;
  let processorApp: NestExpressApplication;
  let api: NestExpressApplication;
  let apiBase: string;
  let processorBase: string;

  beforeAll(async () => {
    pg = await startMigratedPostgres();

    const processorModule = await Test.createTestingModule({ imports: [FakeProcessorModule] }).compile();
    processorApp = processorModule.createNestApplication<NestExpressApplication>({ logger: false });
    await processorApp.listen(0, '127.0.0.1');
    processorBase = (await processorApp.getUrl()).replace('[::1]', '127.0.0.1');

    apiDb = createDb(pg.connectionString, { maxConnections: 20 }); // closed by the app on shutdown
    const apiModule = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(DB)
      .useValue(apiDb)
      .overrideProvider(PROCESSOR_CLIENT_OPTIONS)
      .useValue({ baseUrl: processorBase, timeoutMs: 300 })
      .overrideProvider(PAYMENT_FLOW_OPTIONS)
      .useValue({ callRetries: 2, retryDelayMs: 5, retryMaxDelayMs: 20, random: () => 0.5, feeBps: 150 })
      .compile();
    api = apiModule.createNestApplication<NestExpressApplication>({ logger: false });
    await api.listen(0, '127.0.0.1');
    apiBase = (await api.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await api?.close();
    await processorApp?.close();
    await pg?.stop();
  });

  let merchantId: number;

  // Whatever a test did, the books must still be sound: every success booked, nothing booked
  // without one, debits equal credits.
  afterEach(async () => {
    expect(await checkLedgerInvariants(pg.db)).toEqual([]);
    // ...and every final attempt told the merchant (the outbox event is written with the final status).
    expect(await findAttemptsMissingOutboxEvent(pg.db)).toEqual([]);
  });

  beforeEach(async () => {
    await control('POST', '/reset');
    merchantId = await createMerchant(pg.db);
  });

  // ---- helpers ---------------------------------------------------------------------------------

  async function control(method: string, path: string, json?: unknown) {
    const res = await fetch(`${processorBase}/_control${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  const rule = (r: Record<string, unknown>) => control('POST', '/rules', r);
  const processorStats = () => control('GET', '/stats');
  const processorCharges = async (): Promise<any[]> =>
    ((await (await fetch(`${processorBase}/v1/charges`)).json()) as any).data;

  const newOrder = (over: Record<string, unknown> = {}) => ({
    order_id: `ord_${uid()}`,
    amount: 5000,
    currency: 'NGN',
    source: 'tok_visa',
    ...over,
  });

  interface Reply {
    status: number;
    body: any;
    replayed: boolean;
    retryAfter: string | null;
  }

  async function pay(
    body: unknown,
    opts: { key?: string | null; merchant?: number | string | null } = {},
  ): Promise<Reply> {
    const key = opts.key === undefined ? `key-${uid()}` : opts.key;
    const merchant = opts.merchant === undefined ? merchantId : opts.merchant;
    const res = await fetch(`${apiBase}/v1/payments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'idempotency-key': key } : {}),
        ...(merchant !== null ? { 'x-merchant-id': String(merchant) } : {}),
      },
      body: JSON.stringify(body),
    });
    return {
      status: res.status,
      body: await res.json(),
      replayed: res.headers.get('idempotent-replayed') === 'true',
      retryAfter: res.headers.get('retry-after'),
    };
  }

  async function getPaymentHttp(id: string, merchant: number | null = merchantId) {
    const res = await fetch(`${apiBase}/v1/payments/${id}`, {
      headers: merchant === null ? {} : { 'x-merchant-id': String(merchant) },
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  const attemptsFor = (orderId: string, merchant = merchantId) =>
    pg.db
      .selectFrom('payment_attempts')
      .innerJoin('payment_intents', 'payment_intents.id', 'payment_attempts.payment_intent_id')
      .selectAll('payment_attempts')
      .where('payment_intents.merchant_id', '=', merchant)
      .where('payment_intents.order_id', '=', orderId)
      .orderBy('attempt_number')
      .execute();

  const intentFor = (orderId: string, merchant = merchantId) =>
    pg.db
      .selectFrom('payment_intents')
      .selectAll()
      .where('merchant_id', '=', merchant)
      .where('order_id', '=', orderId)
      .executeTakeFirst();

  const keyRow = (key: string, merchant = merchantId) =>
    pg.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('merchant_id', '=', merchant)
      .where('idempotency_key', '=', key)
      .executeTakeFirst();

  // ---- the normal path -------------------------------------------------------------------------

  describe('a payment that goes through', () => {
    it('charges once and records everything: intent, attempt, charge id, stored response', async () => {
      const order = newOrder();
      const key = `key-${uid()}`;
      const reply = await pay(order, { key });

      expect(reply.status).toBe(201);
      expect(reply.body).toMatchObject({
        object: 'payment',
        order_id: order.order_id,
        amount: 5000,
        currency: 'NGN',
        status: 'succeeded',
        failure_code: null,
        attempt: { number: 1, status: 'succeeded' },
      });
      expect(reply.replayed).toBe(false);

      const intent = (await intentFor(order.order_id))!;
      expect(reply.body.id).toBe(`pay_${intent.id}`);
      expect(intent.status).toBe('succeeded'); // set by the database, not by this code

      const [attempt] = await attemptsFor(order.order_id);
      expect(attempt).toMatchObject({
        status: 'succeeded',
        attempt_number: 1,
        payment_source: 'tok_visa',
        processor_idempotency_key: `pi_${intent.id}_a1`,
      });
      expect(attempt.processor_charge_id).toMatch(/^ch_/);

      // the processor received exactly what the database says it should
      const charges = await processorCharges();
      expect(charges).toHaveLength(1);
      expect(charges[0]).toMatchObject({
        id: attempt.processor_charge_id,
        amount: 5000,
        currency: 'NGN',
        source: 'tok_visa',
        status: 'succeeded',
        metadata: { reference: attempt.processor_idempotency_key, attempt_id: String(attempt.id), order_id: order.order_id },
      });

      // and the key holds the answer, linked to the attempt
      const row = (await keyRow(key))!;
      expect(row).toMatchObject({ attempt_id: attempt.id, response_status: 201 });
      expect(row.completed_at).not.toBeNull();
    });

    it('a duplicate request replays the stored answer: no new attempt, no new charge', async () => {
      const order = newOrder();
      const key = `key-${uid()}`;
      const first = await pay(order, { key });
      const second = await pay(order, { key });
      const third = await pay(order, { key });

      for (const again of [second, third]) {
        expect(again.status).toBe(201);
        expect(again.replayed).toBe(true);
        expect(again.body).toEqual(first.body);
      }
      expect(await attemptsFor(order.order_id)).toHaveLength(1);
      expect(await processorCharges()).toHaveLength(1);
      expect((await processorStats()).replays).toBe(0); // the processor was never even asked again
    });

    it('the same key with a different request is refused with a 422 and changes nothing', async () => {
      const order = newOrder();
      const key = `key-${uid()}`;
      await pay(order, { key });

      const reuse = await pay({ ...order, amount: 9999 }, { key });

      expect(reuse.status).toBe(422);
      expect(reuse.body.error.code).toBe('idempotency_key_reused');
      expect(await processorCharges()).toHaveLength(1);
      expect((await intentFor(order.order_id))!.amount).toBe(5000);
    });

    it('the same key on a reordered body is the same request', async () => {
      const key = `key-${uid()}`;
      const order = newOrder();
      const first = await pay(order, { key });
      const reordered = await pay(
        { source: order.source, currency: order.currency, amount: order.amount, order_id: order.order_id },
        { key },
      );
      expect(reordered.replayed).toBe(true);
      expect(reordered.body).toEqual(first.body);
    });
  });

  describe('requests that are refused before anything happens', () => {
    const noTrace = async (order: { order_id?: unknown }) => {
      const keys = await pg.db.selectFrom('idempotency_keys').select('idempotency_key').where('merchant_id', '=', merchantId).execute();
      expect(keys).toHaveLength(0);
      expect(await processorCharges()).toHaveLength(0);
      if (typeof order.order_id === 'string') expect(await intentFor(order.order_id)).toBeUndefined();
    };

    it.each([
      ['no order_id', { amount: 100, currency: 'NGN', source: 'tok_visa' }],
      ['an empty order_id', newOrder({ order_id: '' })],
      ['a zero amount', newOrder({ amount: 0 })],
      ['a negative amount', newOrder({ amount: -5 })],
      ['a fractional amount', newOrder({ amount: 10.5 })],
      ['an amount sent as a string', newOrder({ amount: '5000' })],
      ['a lowercase currency', newOrder({ currency: 'ngn' })],
      ['no source', { order_id: 'o', amount: 100, currency: 'NGN' }],
      ['an unknown field', newOrder({ surprise: true })],
    ])('400 for %s', async (_name, body) => {
      const reply = await pay(body);
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe('invalid_request');
      await noTrace(body as any);
    });

    it.each([
      ['no Idempotency-Key', null],
      ['an empty key', ''],
      ['a key with a space', 'has space'],
      ['a 256-character key', 'x'.repeat(256)],
    ])('400 for %s', async (_name, key) => {
      const reply = await pay(newOrder(), { key });
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe('invalid_idempotency_key');
      await noTrace({});
    });

    it.each([
      ['no X-Merchant-Id', null],
      ['an unknown merchant', 987654321],
      ['a malformed merchant', 'abc'],
    ])('401 for %s', async (_name, merchant) => {
      const reply = await pay(newOrder(), { merchant });
      expect(reply.status).toBe(401);
      await noTrace({});
    });
  });

  // ---- cards that do not go through -----------------------------------------------------------

  describe('a declined card', () => {
    it('is a 402, fails the attempt, leaves the order open, and is replayed as a 402', async () => {
      const order = newOrder({ source: 'tok_declined' });
      const key = `key-${uid()}`;
      const reply = await pay(order, { key });

      expect(reply.status).toBe(402);
      expect(reply.body).toMatchObject({ status: 'failed', failure_code: 'card_declined', attempt: { number: 1, status: 'failed' } });
      expect((await intentFor(order.order_id))!.status).toBe('open');

      const replay = await pay(order, { key });
      expect(replay).toMatchObject({ status: 402, replayed: true });
      expect(await processorCharges()).toHaveLength(1); // the declined charge, once
    });

    it('lets the customer try again with a NEW key: attempt 2, its own processor key, and one success', async () => {
      const orderId = `ord_${uid()}`;
      await pay(newOrder({ order_id: orderId, source: 'tok_declined' }));

      const retry = await pay(newOrder({ order_id: orderId, source: 'tok_visa' }));

      expect(retry.status).toBe(201);
      expect(retry.body.attempt.number).toBe(2);
      const attempts = await attemptsFor(orderId);
      expect(attempts.map((a) => [a.attempt_number, a.status])).toEqual([[1, 'failed'], [2, 'succeeded']]);
      expect(new Set(attempts.map((a) => a.processor_idempotency_key)).size).toBe(2);
      const charges = await processorCharges();
      expect(charges.map((c) => c.status).sort()).toEqual(['failed', 'succeeded']);
    });

    it('retrying with the SAME key replays the decline; it does not try the card again', async () => {
      const order = newOrder({ source: 'tok_declined' });
      const key = `key-${uid()}`;
      await pay(order, { key });
      const again = await pay(order, { key });
      expect(again).toMatchObject({ status: 402, replayed: true });
      expect(await attemptsFor(order.order_id)).toHaveLength(1);
    });
  });

  describe('a payment that needs more time', () => {
    it('requires_action (3-D Secure): 200, the attempt waits, and the charge id is kept for later', async () => {
      const order = newOrder({ source: 'tok_requires_action' });
      const reply = await pay(order);

      expect(reply.status).toBe(200);
      expect(reply.body.status).toBe('requires_action');
      const [attempt] = await attemptsFor(order.order_id);
      expect(attempt.status).toBe('requires_action');
      expect(attempt.processor_charge_id).toMatch(/^ch_/);
      expect((await intentFor(order.order_id))!.status).toBe('open');
    });

    it('pending: 202, the attempt is processing, and a live read says so', async () => {
      const order = newOrder({ source: 'tok_pending' });
      const reply = await pay(order);

      expect(reply).toMatchObject({ status: 202, body: { status: 'processing', attempt: { status: 'processing' } } });
      const live = await getPaymentHttp(reply.body.id);
      expect(live.body.status).toBe('processing');
    });

    it('while one waits, a new payment for the same order is refused with 409, and the key is not burned', async () => {
      const order = newOrder({ source: 'tok_requires_action' });
      await pay(order);

      const key = `key-${uid()}`;
      const second = await pay({ ...order, source: 'tok_visa' }, { key });

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('payment_already_in_progress');
      expect(second.body.payment.status).toBe('requires_action');
      expect(second.retryAfter).toBe('1');
      expect(await keyRow(key)).toBeUndefined(); // released, so a later retry starts fresh
      expect(await processorCharges()).toHaveLength(1);
    });
  });

  // ---- Module 2: what goes wrong between us and the processor ---------------------------------

  describe('when the processor call goes wrong (failure mode 2.2 and 2.3)', () => {
    it.each([
      ['the response is lost after the charge (connection dropped)', { fault: 'drop_after' }],
      ['the processor answers 500 after charging', { fault: 'error_after' }],
    ])('%s: the retry with the SAME key finds the charge, so there is exactly one', async (_name, faultRule) => {
      await rule(faultRule);
      const order = newOrder();
      const reply = await pay(order);

      expect(reply.status).toBe(201);
      expect(reply.body.status).toBe('succeeded');
      expect(await attemptsFor(order.order_id)).toHaveLength(1);
      expect(await processorCharges()).toHaveLength(1);
      expect((await processorStats()).replays).toBe(1); // proof: we asked twice, with the same key
    });

    it('a gateway that fails before processing is retried and succeeds on the third try', async () => {
      await rule({ fault: 'gateway_error', times: 2 });
      const reply = await pay(newOrder());

      expect(reply.status).toBe(201);
      expect(await processorCharges()).toHaveLength(1);
      expect((await processorStats()).replays).toBe(0); // nothing had been charged, so nothing to replay
    });

    it('pauses between retries by the jittered backoff policy, not a fixed doubling', async () => {
      // random is pinned to 0.5 in this suite: with a 5 ms base the policy waits floor(0.5 * 5) = 2 ms,
      // then floor(0.5 * 10) = 5 ms. Plain doubling would have waited 5 ms, then 10 ms.
      const spy = jest.spyOn(global, 'setTimeout');
      try {
        await rule({ fault: 'gateway_error', times: 2 });
        expect((await pay(newOrder())).status).toBe(201);
        const delays = spy.mock.calls.map((c) => c[1]);
        const sleeps = delays.filter((d) => d === 2 || d === 5);
        expect(sleeps).toEqual(expect.arrayContaining([2, 5]));
        expect(delays).not.toContain(10);
      } finally {
        spy.mockRestore();
      }
    });

    it('a response slower than our timeout is not a failure: we ask again and get the charge that was made', async () => {
      await rule({ responseDelayMs: 800 }); // charge happens, reply arrives after the 300 ms timeout
      const order = newOrder();
      const reply = await pay(order);

      expect(reply.status).toBe(201);
      expect(await processorCharges()).toHaveLength(1);
      expect((await processorStats()).replays).toBe(1);
      expect(await attemptsFor(order.order_id)).toHaveLength(1);
    });

    it('a definitive refusal is never retried', async () => {
      const order = newOrder({ source: 'tok_declined' });
      await pay(order);
      const stats = await processorStats();
      expect(stats.charges).toBe(1);
      expect(stats.replays).toBe(0);
    });

    describe('an outage that outlasts every retry', () => {
      it('before any charge: 202 processing, the attempt stays calling_processor, nothing is charged', async () => {
        await rule({ fault: 'gateway_error', times: null });
        const order = newOrder();
        const key = `key-${uid()}`;
        const reply = await pay(order, { key });

        expect(reply.status).toBe(202);
        expect(reply.body.status).toBe('processing');
        const [attempt] = await attemptsFor(order.order_id);
        expect(attempt.status).toBe('calling_processor'); // NOT failed: we do not know
        expect((await intentFor(order.order_id))!.status).toBe('open');
        expect(await processorCharges()).toHaveLength(0);

        const replay = await pay(order, { key });
        expect(replay).toMatchObject({ status: 202, replayed: true });
      });

      it('after the charge: the customer is NOT charged again, even with a new key and a healthy processor', async () => {
        await rule({ fault: 'error_after', times: null });
        const order = newOrder();
        const first = await pay(order);
        expect(first.status).toBe(202); // we could never see the answer...
        expect(await processorCharges()).toHaveLength(1); // ...but the money moved

        await control('DELETE', '/rules'); // the processor recovers
        const second = await pay(order); // customer clicks pay again, new key

        expect(second.status).toBe(409);
        expect(second.body.error.code).toBe('payment_already_in_progress');
        expect(await processorCharges()).toHaveLength(1); // still exactly one
        expect(await attemptsFor(order.order_id)).toHaveLength(1);
      });

      it('the unresolved attempt is what blocks the second charge, not luck of timing', async () => {
        await rule({ fault: 'gateway_error', times: null });
        const order = newOrder();
        await pay(order);
        await control('DELETE', '/rules');

        const second = await pay(order);
        expect(second.status).toBe(409);
        expect(second.body.payment.attempt.status).toBe('calling_processor');
        expect(await processorCharges()).toHaveLength(0);
      });
    });
  });

  // ---- Module 2: concurrency ------------------------------------------------------------------

  describe('concurrent requests (failure modes 2.1, 2.4 and 2.7)', () => {
    it('20 simultaneous identical requests: one charge, one real answer, everyone else a replay or a retryable 409', async () => {
      await rule({ processingDelayMs: 200 }); // widen the race window at the processor
      const order = newOrder();
      const key = `key-${uid()}`;

      const replies = await Promise.all(Array.from({ length: 20 }, () => pay(order, { key })));

      for (const r of replies) expect([201, 409]).toContain(r.status); // never a 5xx, never a failure
      const winners = replies.filter((r) => r.status === 201 && !r.replayed);
      expect(winners).toHaveLength(1);
      for (const r of replies.filter((r) => r.status === 201)) expect(r.body).toEqual(winners[0].body);
      for (const r of replies.filter((r) => r.status === 409)) expect(r.body.error.code).toBe('idempotency_request_in_progress');

      expect(await attemptsFor(order.order_id)).toHaveLength(1);
      expect(await processorCharges()).toHaveLength(1);

      expect(await pay(order, { key })).toMatchObject({ status: 201, replayed: true });
    });

    it('12 simultaneous requests for the SAME ORDER with 12 DIFFERENT keys: one charge, ever (the headline guarantee)', async () => {
      await rule({ processingDelayMs: 200 });
      const order = newOrder();

      const replies = await Promise.all(Array.from({ length: 12 }, () => pay(order)));

      const paid = replies.filter((r) => r.status === 201);
      expect(paid).toHaveLength(1);
      for (const r of replies.filter((r) => r.status !== 201)) {
        expect(r.status).toBe(409);
        expect(['payment_already_in_progress', 'order_already_paid']).toContain(r.body.error.code);
      }

      expect(await attemptsFor(order.order_id)).toHaveLength(1);
      expect(await processorCharges()).toHaveLength(1);
      expect((await intentFor(order.order_id))!.status).toBe('succeeded');
    });

    it('requests for different orders never block each other', async () => {
      const replies = await Promise.all(Array.from({ length: 15 }, () => pay(newOrder())));
      expect(replies.every((r) => r.status === 201)).toBe(true);
      expect(await processorCharges()).toHaveLength(15);
    });
  });

  // ---- orders that already have a history ------------------------------------------------------

  describe('an order that already has a history', () => {
    it('an order that is already paid is a 409 with the existing payment, and no new charge', async () => {
      const order = newOrder();
      const paid = await pay(order);

      const key = `key-${uid()}`;
      const again = await pay(order, { key });

      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('order_already_paid');
      expect(again.body.payment).toMatchObject({ id: paid.body.id, status: 'succeeded' });
      expect(await processorCharges()).toHaveLength(1);
      expect(await pay(order, { key })).toMatchObject({ status: 409, replayed: true }); // permanent, so stored
    });

    it('an existing order requested with a different amount or currency is a 422', async () => {
      const order = newOrder({ source: 'tok_declined' });
      await pay(order);

      for (const change of [{ amount: 7000 }, { currency: 'USD' }]) {
        const reply = await pay({ ...order, ...change, source: 'tok_visa' });
        expect(reply.status).toBe(422);
        expect(reply.body.error.code).toBe('order_mismatch');
      }
      expect(await processorCharges()).toHaveLength(1);
    });

    it('a canceled order cannot be paid', async () => {
      const order = newOrder({ source: 'tok_declined' });
      await pay(order);
      await pg.db.updateTable('payment_intents').set({ status: 'canceled' }).where('order_id', '=', order.order_id).execute();

      const reply = await pay({ ...order, source: 'tok_visa' });
      expect(reply.status).toBe(409);
      expect(reply.body.error.code).toBe('order_canceled');
    });
  });

  describe('merchants are isolated', () => {
    it('the same order id and the same idempotency key for two merchants are two independent payments', async () => {
      const other = await createMerchant(pg.db);
      const order = newOrder();
      const key = `shared-${uid()}`;

      const a = await pay(order, { key });
      const b = await pay(order, { key, merchant: other });

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.replayed).toBe(false);
      expect(a.body.id).not.toBe(b.body.id);
      expect(await processorCharges()).toHaveLength(2);
    });
  });

  describe('GET /v1/payments/:id', () => {
    it('shows the payment as it is now, to its own merchant only', async () => {
      const order = newOrder();
      const created = await pay(order);

      const own = await getPaymentHttp(created.body.id);
      expect(own.status).toBe(200);
      expect(own.body).toEqual(created.body);

      const other = await createMerchant(pg.db);
      expect((await getPaymentHttp(created.body.id, other)).status).toBe(404);
      expect((await getPaymentHttp(created.body.id, null)).status).toBe(401);
    });

    it.each(['pay_999999999', 'pay_abc', 'nonsense', 'pay_', 'pay_1; drop table'])('404 for %s', async (id) => {
      expect((await getPaymentHttp(encodeURIComponent(id))).status).toBe(404);
    });
  });
  describe('the ledger (Stage 6)', () => {
    const ledgerLines = async (orderId: string) => {
      const attempts = await attemptsFor(orderId);
      const rows = await pg.db
        .selectFrom('ledger_transactions as t')
        .innerJoin('ledger_entries as e', 'e.transaction_id', 't.id')
        .innerJoin('ledger_accounts as a', 'a.id', 'e.account_id')
        .select(['a.code', 'e.direction', 'e.amount'])
        .where('t.posting_key', 'in', attempts.map((a) => `attempt:${a.id}:succeeded`))
        .orderBy('a.code')
        .execute();
      return rows.map((r) => ({ code: r.code, direction: r.direction, amount: Number(r.amount) }));
    };

    const balance = async (merchant: number | null = merchantId) => {
      const res = await fetch(`${apiBase}/v1/balance`, {
        headers: merchant === null ? {} : { 'x-merchant-id': String(merchant) },
      });
      return { status: res.status, body: (await res.json()) as any };
    };

    it('books a successful payment: receivable, merchant payable and platform fee', async () => {
      const order = newOrder({ amount: 5000 });
      expect((await pay(order)).status).toBe(201);

      expect(await ledgerLines(order.order_id)).toEqual([
        { code: `merchant_payable:${merchantId}:NGN`, direction: 'credit', amount: 4925 },
        { code: 'platform_fee_revenue:NGN', direction: 'credit', amount: 75 },
        { code: 'processor_receivable:NGN', direction: 'debit', amount: 5000 },
      ]);
    });

    it('books once however many times the request is retried', async () => {
      const order = newOrder();
      const key = `key-${uid()}`;
      for (let i = 0; i < 3; i++) await pay(order, { key });
      expect(await ledgerLines(order.order_id)).toHaveLength(3);
    });

    it('books once when identical requests race', async () => {
      const order = newOrder();
      const key = `key-${uid()}`;
      await Promise.all(Array.from({ length: 5 }, () => pay(order, { key })));
      expect(await ledgerLines(order.order_id)).toHaveLength(3);
    });

    it('books nothing for a declined payment', async () => {
      const order = newOrder({ source: 'tok_declined' });
      expect((await pay(order)).status).toBe(402);
      expect(await ledgerLines(order.order_id)).toEqual([]);
    });

    it('books nothing for a payment that is still processing', async () => {
      const order = newOrder({ source: 'tok_pending' });
      await pay(order);
      expect(await ledgerLines(order.order_id)).toEqual([]);
    });

    it('a retry after a lost response does not book a second time', async () => {
      await rule({ fault: 'drop_after' });
      const order = newOrder();
      expect((await pay(order)).status).toBe(201);
      expect(await processorCharges()).toHaveLength(1);
      expect(await ledgerLines(order.order_id)).toHaveLength(3);
    });

    describe('GET /v1/balance', () => {
      it('is empty before any payment', async () => {
        expect(await balance()).toEqual({ status: 200, body: { object: 'balance', available: [] } });
      });

      it('adds up what the merchant is owed, net of fees, per currency', async () => {
        await pay(newOrder({ amount: 5000 }));
        await pay(newOrder({ amount: 2000 }));
        await pay(newOrder({ amount: 1000, currency: 'GHS' }));
        expect((await balance()).body.available).toEqual([
          { currency: 'GHS', amount: 985 },
          { currency: 'NGN', amount: 6895 },
        ]);
      });

      it('does not count payments that did not succeed', async () => {
        await pay(newOrder({ source: 'tok_declined' }));
        expect((await balance()).body.available).toEqual([]);
      });

      it("never shows another merchant's money", async () => {
        const other = await createMerchant(pg.db);
        await pay(newOrder({ amount: 5000 }), { merchant: other });
        expect((await balance()).body.available).toEqual([]);
        expect((await balance(other)).body.available).toEqual([{ currency: 'NGN', amount: 4925 }]);
      });

      it('refuses an unknown merchant', async () => {
        expect((await balance(null)).status).toBe(401);
      });
    });

    it('rolls the whole settlement back when the books cannot take the posting', async () => {
      // Sabotage: an account with the payable's code but the wrong kind. Booking will fail.
      const code = `merchant_payable:${merchantId}:GHS`;
      await pg.db.insertInto('ledger_accounts').values({ code, kind: 'expense', currency: 'GHS' }).execute();

      const order = newOrder({ currency: 'GHS' });
      const key = `key-${uid()}`;
      const reply = await pay(order, { key });

      expect(reply.status).toBe(500);
      // the customer WAS charged, exactly once, and the payment is not marked paid without books
      expect(await processorCharges()).toHaveLength(1);
      const [attempt] = await attemptsFor(order.order_id);
      expect(attempt.status).toBe('calling_processor');
      expect(attempt.processor_charge_id).toBeNull();
      expect(await ledgerLines(order.order_id)).toEqual([]);

      // the claim is kept, so a retry with the same key is held rather than charging again
      const retry = await pay(order, { key });
      expect(retry.status).not.toBe(201);
      expect(await processorCharges()).toHaveLength(1);
    });
  });
  describe('merchant notification (Stage 8)', () => {
    const outboxFor = (orderId: string) =>
      pg.db
        .selectFrom('outbox_events as o')
        .innerJoin('payment_attempts as a', (j) => j.on(sql<boolean>`o.dedupe_key like '%:attempt:' || a.id`))
        .innerJoin('payment_intents as i', 'i.id', 'a.payment_intent_id')
        .select(['o.event_type', 'o.status', 'o.payload'])
        .where('i.order_id', '=', orderId)
        .execute();

    it('a successful payment queues exactly one payment.succeeded event for the merchant', async () => {
      const order = newOrder();
      const key = `key-${uid()}`;
      for (let i = 0; i < 3; i++) await pay(order, { key }); // replays must not queue again
      const events = await outboxFor(order.order_id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event_type: 'payment.succeeded', status: 'pending' });
    });

    it('a declined payment queues payment.failed', async () => {
      const order = newOrder({ source: 'tok_declined' });
      await pay(order);
      expect((await outboxFor(order.order_id)).map((e) => e.event_type)).toEqual(['payment.failed']);
    });

    it('a payment that is still processing tells the merchant nothing yet', async () => {
      const order = newOrder({ source: 'tok_pending' });
      await pay(order);
      expect(await outboxFor(order.order_id)).toEqual([]);
    });

    it('rolls back with everything else when booking fails: no event for a payment that is not finished', async () => {
      await pg.db.insertInto('ledger_accounts').values({ code: `merchant_payable:${merchantId}:GHS`, kind: 'expense', currency: 'GHS' }).execute();
      const order = newOrder({ currency: 'GHS' });
      expect((await pay(order)).status).toBe(500);
      expect(await outboxFor(order.order_id)).toEqual([]);
    });
  });
});

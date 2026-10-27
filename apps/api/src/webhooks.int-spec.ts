import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { checkLedgerInvariants, createDb, DB } from '@app/db';
import type { Database } from '@app/db';
import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from '@app/payments-core';
import { createMerchant, startMigratedPostgres, TestPostgres, uid } from '@app/testing';
import { FakeProcessorModule } from '../../fake-processor/src/fake-processor.module';
import { ApiModule } from './api.module';
import { NEST_APP_OPTIONS } from './bootstrap';
import { PAYMENT_FLOW_OPTIONS } from './payments.service';
import { PROCESSOR_CLIENT_OPTIONS } from './processor.client';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Stage 7, end to end: the fake processor really POSTs signed webhooks to the real API, which
 * verifies them against the raw bytes and handles each event once. Duplicates, ordering and failures
 * are provoked from the processor's remote control, the same way a real processor would misbehave.
 */
describe('POST /webhooks/processor (API + Postgres + fake processor)', () => {
  let pg: TestPostgres;
  let apiDb: Kysely<Database>;
  let processorApp: NestExpressApplication;
  let api: NestExpressApplication;
  let apiBase: string;
  let processorBase: string;
  let merchantId: number;
  const secret = process.env.PROCESSOR_WEBHOOK_SECRET as string;

  beforeAll(async () => {
    pg = await startMigratedPostgres();

    const processorModule = await Test.createTestingModule({ imports: [FakeProcessorModule] }).compile();
    processorApp = processorModule.createNestApplication<NestExpressApplication>({ logger: false });
    await processorApp.listen(0, '127.0.0.1');
    processorBase = (await processorApp.getUrl()).replace('[::1]', '127.0.0.1');

    apiDb = createDb(pg.connectionString, { maxConnections: 20 });
    const apiModule = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(DB)
      .useValue(apiDb)
      .overrideProvider(PROCESSOR_CLIENT_OPTIONS)
      .useValue({ baseUrl: processorBase, timeoutMs: 300 })
      .overrideProvider(PAYMENT_FLOW_OPTIONS)
      .useValue({ callRetries: 2, retryDelayMs: 5, feeBps: 150 })
      .compile();
    api = apiModule.createNestApplication<NestExpressApplication>({ logger: false, ...NEST_APP_OPTIONS });
    await api.listen(0, '127.0.0.1');
    apiBase = (await api.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await api?.close();
    await processorApp?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    await control('POST', '/reset');
    // reset() restores the processor's defaults, so point it at the API again, without retries so a
    // refused delivery shows up as exactly one failed attempt.
    await control('PUT', '/webhook', { url: `${apiBase}/webhooks/processor`, maxRetries: 0, retryDelayMs: 0 });
    merchantId = await createMerchant(pg.db);
    // Each test counts the events it caused (DELETE is allowed on purpose: retention cleanup).
    await pg.db.deleteFrom('webhook_events').execute();
  });

  afterEach(async () => {
    expect(await checkLedgerInvariants(pg.db)).toEqual([]);
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

  const processorEvents = async (): Promise<any[]> => (await control('GET', '/events')).data;
  const processorCharges = async (): Promise<any[]> =>
    ((await (await fetch(`${processorBase}/v1/charges`)).json()) as any).data;

  async function pay(source: string, over: Record<string, unknown> = {}) {
    const res = await fetch(`${apiBase}/v1/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `key-${uid()}`, 'x-merchant-id': String(merchantId) },
      body: JSON.stringify({ order_id: `ord_${uid()}`, amount: 5000, currency: 'NGN', source, ...over }),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  async function getPayment(id: string) {
    const res = await fetch(`${apiBase}/v1/payments/${id}`, { headers: { 'x-merchant-id': String(merchantId) } });
    return (await res.json()) as any;
  }

  const chargeOf = async (orderId: string) => (await processorCharges()).find((c) => c.metadata.order_id === orderId);
  const resolve = (chargeId: string, outcome: 'succeeded' | 'failed', failureCode?: string) =>
    control('POST', `/charges/${chargeId}/resolve`, { outcome, failureCode });

  const postingCount = async (paymentId: string) => {
    const intentId = Number(paymentId.replace('pay_', ''));
    const rows = await pg.db
      .selectFrom('ledger_transactions as t')
      .innerJoin('payment_attempts as a', (j) => j.on(sql<boolean>`t.posting_key = 'attempt:' || a.id || ':succeeded'`))
      .select('t.id')
      .where('a.payment_intent_id', '=', intentId)
      .execute();
    return rows.length;
  };
  const eventRows = () => pg.db.selectFrom('webhook_events').selectAll().orderBy('id').execute();

  async function sendRaw(raw: string, header: string | null | undefined = undefined) {
    const sig =
      header === undefined
        ? signWebhook({ secret, payload: raw, timestamp: Math.floor(Date.now() / 1000) })
        : header;
    const res = await fetch(`${apiBase}/webhooks/processor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(sig ? { [WEBHOOK_SIGNATURE_HEADER]: sig } : {}) },
      body: raw,
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  const wellFormed = () =>
    JSON.stringify({
      id: `evt_${uid()}`,
      object: 'event',
      type: 'charge.succeeded',
      created: 1,
      data: { object: { id: 'ch_x', amount: 5000, currency: 'NGN', status: 'succeeded', metadata: { reference: 'pi_none' } } },
    });

  // ---- a payment that finishes later ----------------------------------------------------------

  describe('a payment that completes after the API has answered', () => {
    it('pending, then succeeded: the webhook completes it and books the ledger', async () => {
      const order = `ord_${uid()}`;
      const created = await pay('tok_pending', { order_id: order });
      expect(created.status).toBe(202);
      expect(created.body.status).toBe('processing');

      const charge = await chargeOf(order);
      await resolve(charge.id, 'succeeded');
      await processorEvents(); // waits for the delivery to finish

      const payment = await getPayment(created.body.id);
      expect(payment.status).toBe('succeeded');
      expect(await postingCount(created.body.id)).toBe(1);
      const rows = await eventRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ result: 'applied', event_type: 'charge.succeeded' });

      const balance = await (
        await fetch(`${apiBase}/v1/balance`, { headers: { 'x-merchant-id': String(merchantId) } })
      ).json();
      expect((balance as any).available).toEqual([{ currency: 'NGN', amount: 4925 }]);
    });

    it('requires_action, then succeeded (the customer completed 3-D Secure)', async () => {
      const order = `ord_${uid()}`;
      const created = await pay('tok_requires_action', { order_id: order });
      expect(created.body.status).toBe('requires_action');

      await resolve((await chargeOf(order)).id, 'succeeded');
      await processorEvents();

      expect((await getPayment(created.body.id)).status).toBe('succeeded');
      expect(await postingCount(created.body.id)).toBe(1);
    });

    it('pending, then failed: the attempt fails with the processor reason and nothing is booked', async () => {
      const order = `ord_${uid()}`;
      const created = await pay('tok_pending', { order_id: order });
      await resolve((await chargeOf(order)).id, 'failed', 'insufficient_funds');
      await processorEvents();

      const payment = await getPayment(created.body.id);
      expect(payment.status).toBe('failed');
      expect(payment.failure_code).toBe('insufficient_funds');
      expect(await postingCount(created.body.id)).toBe(0);
    });
  });

  // ---- at-least-once delivery -----------------------------------------------------------------

  describe('the processor delivers at least once', () => {
    it('three extra copies of an event change nothing the second time', async () => {
      await control('PUT', '/webhook', { duplicates: 3 });
      const order = `ord_${uid()}`;
      const created = await pay('tok_pending', { order_id: order });
      await resolve((await chargeOf(order)).id, 'succeeded');
      const events = await processorEvents();

      expect(events.at(-1).deliveries).toHaveLength(4);
      expect(events.at(-1).deliveries.every((d: any) => d.status === 200)).toBe(true);
      expect(await eventRows()).toHaveLength(1);
      expect(await postingCount(created.body.id)).toBe(1);
      expect((await getPayment(created.body.id)).status).toBe('succeeded');
    });

    it('a manual "resend" days later is acknowledged and does nothing', async () => {
      const order = `ord_${uid()}`;
      const created = await pay('tok_pending', { order_id: order });
      await resolve((await chargeOf(order)).id, 'succeeded');
      const [event] = (await processorEvents()).slice(-1);

      await control('POST', `/events/${event.id}/redeliver`);
      const after = await processorEvents();
      expect(after.at(-1).deliveries.at(-1).status).toBe(200);
      expect(await postingCount(created.body.id)).toBe(1);
      expect(await eventRows()).toHaveLength(1);
    });

    it('events held back and delivered in reverse order still leave every payment correct', async () => {
      await control('PUT', '/webhook', { mode: 'hold' });
      const orders = [`ord_${uid()}`, `ord_${uid()}`, `ord_${uid()}`];
      const created = [];
      for (const order of orders) created.push(await pay('tok_pending', { order_id: order }));
      const outcomes = ['succeeded', 'failed', 'succeeded'] as const;
      for (const [i, order] of orders.entries()) await resolve((await chargeOf(order)).id, outcomes[i]);

      await control('POST', '/webhook/flush', { order: 'reverse' });
      await processorEvents();

      expect((await Promise.all(created.map((c) => getPayment(c.body.id)))).map((p) => p.status)).toEqual([
        'succeeded',
        'failed',
        'succeeded',
      ]);
      expect(await eventRows()).toHaveLength(3);
    });

    it('the webhook can arrive before the API has the answer: one charge, one posting, both agree', async () => {
      // The charge happens, its webhook is sent at once, but the HTTP response is slower than our
      // timeout. The webhook completes the payment; the API's retry then finds it already done.
      await control('POST', '/rules', { responseDelayMs: 800 });
      const order = `ord_${uid()}`;
      const created = await pay('tok_visa', { order_id: order });

      expect(created.status).toBe(201);
      expect(created.body.status).toBe('succeeded');
      expect(await processorCharges()).toHaveLength(1);
      expect(await postingCount(created.body.id)).toBe(1);
      const rows = await eventRows();
      expect(rows).toHaveLength(1);
      expect(['applied', 'already_applied']).toContain(rows[0].result);
    });
  });

  // ---- trust: who is allowed to say a payment succeeded ---------------------------------------

  describe('only the processor can say so', () => {
    const before = async () => (await eventRows()).length;

    it('refuses an unsigned request', async () => {
      const r = await sendRaw(wellFormed(), null);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_signature');
      expect(await before()).toBe(0);
    });

    it('refuses a signature made with the wrong secret', async () => {
      const raw = wellFormed();
      const bad = signWebhook({ secret: 'some-other-secret-1234', payload: raw, timestamp: Math.floor(Date.now() / 1000) });
      expect((await sendRaw(raw, bad)).status).toBe(400);
      expect(await before()).toBe(0);
    });

    it('refuses a body changed after signing', async () => {
      const raw = wellFormed();
      const header = signWebhook({ secret, payload: raw, timestamp: Math.floor(Date.now() / 1000) });
      expect((await sendRaw(raw.replace('5000', '1'), header)).status).toBe(400);
    });

    it('verifies the exact bytes: the same JSON with different spacing does not pass', async () => {
      const raw = wellFormed();
      const header = signWebhook({ secret, payload: raw, timestamp: Math.floor(Date.now() / 1000) });
      const respaced = JSON.stringify(JSON.parse(raw), null, 2);
      expect((await sendRaw(respaced, header)).status).toBe(400);
    });

    it('refuses an old signed delivery (replay)', async () => {
      const raw = wellFormed();
      const old = signWebhook({ secret, payload: raw, timestamp: Math.floor(Date.now() / 1000) - 3600 });
      expect((await sendRaw(raw, old)).status).toBe(400);
      expect(await before()).toBe(0);
    });

    it('refuses a malformed header', async () => {
      expect((await sendRaw(wellFormed(), 'garbage')).status).toBe(400);
    });

    it('a correctly signed body that is not an event is a 400, not a crash', async () => {
      const r = await sendRaw('{"hello":"world"}');
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_payload');
    });

    it('a correctly signed charge event for a charge we never made is recorded and acknowledged', async () => {
      const r = await sendRaw(wellFormed());
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ received: true, duplicate: false, result: 'unmatched' });
      expect((await eventRows())[0].result).toBe('unmatched');
    });

    it('an event type we do not handle is acknowledged', async () => {
      const raw = JSON.stringify({ id: `evt_${uid()}`, type: 'payout.paid', data: { object: {} } });
      expect((await sendRaw(raw)).body.result).toBe('ignored');
    });

    it('a signed, well-formed charge.succeeded with the WRONG amount is not applied', async () => {
      const order = `ord_${uid()}`;
      const created = await pay('tok_pending', { order_id: order });
      const charge = await chargeOf(order);
      const raw = JSON.stringify({
        id: `evt_${uid()}`,
        type: 'charge.succeeded',
        data: { object: { id: charge.id, amount: 1, currency: 'NGN', status: 'succeeded', metadata: charge.metadata } },
      });
      expect((await sendRaw(raw)).body.result).toBe('mismatch');
      expect((await getPayment(created.body.id)).status).toBe('processing');
      expect(await postingCount(created.body.id)).toBe(0);
    });
  });

  // ---- when handling itself breaks ------------------------------------------------------------

  describe('when our side fails, the processor is told to try again, and the retry works', () => {
    afterEach(async () => {
      await sql`DROP TRIGGER IF EXISTS test_break_webhooks ON webhook_events`.execute(pg.db);
      await sql`DROP FUNCTION IF EXISTS test_break_webhooks()`.execute(pg.db);
    });

    it('answers 5xx, leaves no trace of the event, and applies it on redelivery', async () => {
      const order = `ord_${uid()}`;
      const created = await pay('tok_pending', { order_id: order });

      await sql`CREATE FUNCTION test_break_webhooks() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated outage'; END $$`.execute(pg.db);
      await sql`CREATE TRIGGER test_break_webhooks BEFORE INSERT ON webhook_events FOR EACH ROW EXECUTE FUNCTION test_break_webhooks()`.execute(pg.db);

      await resolve((await chargeOf(order)).id, 'succeeded');
      const [event] = (await processorEvents()).slice(-1);
      expect(event.deliveries.map((d: any) => d.status)).toEqual([500]);
      expect(await eventRows()).toHaveLength(0);
      expect((await getPayment(created.body.id)).status).toBe('processing');

      await sql`DROP TRIGGER test_break_webhooks ON webhook_events`.execute(pg.db);
      await control('POST', `/events/${event.id}/redeliver`);
      await processorEvents();

      expect((await getPayment(created.body.id)).status).toBe('succeeded');
      expect(await postingCount(created.body.id)).toBe(1);
      expect(await eventRows()).toHaveLength(1);
    });
  });
});

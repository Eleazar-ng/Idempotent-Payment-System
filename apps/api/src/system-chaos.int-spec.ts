import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { checkLedgerInvariants, createDb, DB, findAttemptsMissingOutboxEvent, listOpenFindings } from '@app/db';
import type { Database } from '@app/db';
import { createMerchant, createTestApiKey, startMigratedPostgres, TestPostgres, uid } from '@app/testing';
import { EVENT_ID_HEADER } from '@app/payments-core';
import { FakeProcessorModule } from '../../fake-processor/src/fake-processor.module';
import { OutboxRelay } from '../../worker/src/outbox-relay';
import { ProcessorLookup } from '../../worker/src/processor-lookup';
import { Reconciler } from '../../worker/src/reconciler';
import { RecoverySweeper } from '../../worker/src/recovery-sweeper';
import { ApiModule } from './api.module';
import { PAYMENT_FLOW_OPTIONS } from './payments.service';
import { PROCESSOR_CLIENT_OPTIONS } from './processor.client';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Stage 12, the capstone: the whole system at once, under fire.
 *
 * Real API, real worker loops (sweeper, reconciler, outbox relay), real Postgres, the real fake processor, and a real
 * merchant HTTP server. Many clients pay many orders concurrently. Each order is sent by several clients at once with the
 * SAME idempotency key, and every client retries like a real one. Meanwhile the processor drops connections after charging,
 * answers 500 after charging, answers too slowly, declines, and sends every webhook three times; the merchant fails some
 * of its first deliveries; and the recovery loops run against live traffic.
 *
 * Afterwards the system is asked questions that only an exactly-once-in-effect design can answer "yes" to. No single
 * stage's test proves these; they hold only if every stage's guarantee holds together.
 */
describe('system under chaos (API + worker loops + Postgres + processor + merchant)', () => {
  const CLIENTS_PER_ORDER = 4;
  const ORDERS_PER_SOURCE = 6;

  /** What the processor is told to do to each kind of card, and what the customer is entitled to at the end. */
  const SCENARIOS = {
    tok_visa: { rule: null, final: 'succeeded' },
    tok_chaos_decline: { rule: { outcome: 'decline' }, final: 'failed' },
    // the money moved, the caller never heard: connection dropped / 500 / too slow, on EVERY try including replays
    tok_chaos_drop_after: { rule: { fault: 'drop_after' }, final: 'succeeded' },
    tok_chaos_error_after: { rule: { fault: 'error_after' }, final: 'succeeded' },
    tok_chaos_slow: { rule: { responseDelayMs: 700 }, final: 'succeeded' },
    // nothing happened at the processor; the API's own retries get through
    tok_chaos_gateway: { rule: { fault: 'gateway_error', times: 3 }, final: 'succeeded' },
  } as const;
  type Source = keyof typeof SCENARIOS;

  let pg: TestPostgres;
  let apiDb: Kysely<Database>;
  let processorApp: NestExpressApplication;
  let api: NestExpressApplication;
  let merchantServer: Server;
  let apiBase: string;
  let processorBase: string;
  let merchantBase: string;

  /** Every delivery the merchant's server saw: event id -> times seen. Merchants must dedupe on this, so duplicates are expected. */
  const seenEvents = new Map<string, number>();
  let merchantRequests = 0;

  beforeAll(async () => {
    pg = await startMigratedPostgres();

    const processorModule = await Test.createTestingModule({ imports: [FakeProcessorModule] }).compile();
    processorApp = processorModule.createNestApplication<NestExpressApplication>({ logger: false });
    await processorApp.listen(0, '127.0.0.1');
    processorBase = (await processorApp.getUrl()).replace('[::1]', '127.0.0.1');

    apiDb = createDb(pg.connectionString, { maxConnections: 30 });
    const apiModule = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(DB)
      .useValue(apiDb)
      .overrideProvider(PROCESSOR_CLIENT_OPTIONS)
      .useValue({ baseUrl: processorBase, timeoutMs: 300 })
      .overrideProvider(PAYMENT_FLOW_OPTIONS)
      .useValue({ callRetries: 3, retryDelayMs: 5, retryMaxDelayMs: 20, random: () => 0.5, feeBps: 150 })
      .compile();
    api = apiModule.createNestApplication<NestExpressApplication>({ logger: false });
    await api.listen(0, '127.0.0.1');
    apiBase = (await api.getUrl()).replace('[::1]', '127.0.0.1');

    // The merchant: refuses the FIRST delivery of every third event id with a 500, accepts the rest.
    merchantServer = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        merchantRequests++;
        const id = String(req.headers[EVENT_ID_HEADER] ?? '');
        const seen = (seenEvents.get(id) ?? 0) + 1;
        seenEvents.set(id, seen);
        const refuse = seen === 1 && Number(id.replace(/\D/g, '')) % 3 === 0;
        res.writeHead(refuse ? 500 : 200).end('ok');
      });
    });
    await new Promise<void>((resolve) => merchantServer.listen(0, '127.0.0.1', resolve));
    merchantBase = `http://127.0.0.1:${(merchantServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await api?.close();
    await processorApp?.close();
    merchantServer?.closeAllConnections();
    await new Promise<void>((resolve) => merchantServer?.close(() => resolve()));
    await pg?.stop();
  });

  const control = async (method: string, path: string, json?: unknown) => {
    const res = await fetch(`${processorBase}/_control${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  interface Order {
    merchantId: number;
    key: string;
    apiKey: string;
    source: Source;
    body: { order_id: string; amount: number; currency: string; source: string };
  }
  interface Reply {
    status: number;
    body: any;
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const jitter = (min: number, max: number) => min + Math.random() * (max - min);

  async function post(order: Order, body: unknown = order.body, key = order.key): Promise<Reply> {
    try {
      const res = await fetch(`${apiBase}/v1/payments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key, authorization: `Bearer ${order.apiKey}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch {
      return { status: 0, body: null }; // the network ate it: a real client cannot tell what happened either
    }
  }

  async function get(order: Order, id: string): Promise<Reply> {
    try {
      const res = await fetch(`${apiBase}/v1/payments/${id}`, { headers: { authorization: `Bearer ${order.apiKey}` } });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch {
      return { status: 0, body: null };
    }
  }

  /** A client that behaves like a careful real one: it keeps asking with the SAME key until it gets a final answer. */
  async function payUntilFinal(order: Order, replies: Reply[]): Promise<Reply> {
    for (let tryNo = 0; tryNo < 120; tryNo++) {
      const reply = await post(order);
      replies.push(reply);
      if (reply.status === 201 || reply.status === 402) return reply; // a final answer, replayed identically from now on
      if (reply.status === 202 && reply.body?.id) {
        // "still processing" is a snapshot: the documented way to learn the end is to read the payment (README, Stage 9)
        const polled = await get(order, reply.body.id);
        if (polled.body?.status === 'succeeded' || polled.body?.status === 'failed') {
          const final = { status: polled.body.status === 'succeeded' ? 201 : 402, body: polled.body };
          replies.push(final);
          return final;
        }
      }
      await sleep(jitter(20, 80)); // 202 still processing, 409 in progress, 5xx, or no answer at all: ask again
    }
    const state = await sql`SELECT a.id, a.status, a.processor_charge_id, a.updated_at, k.response_status, k.completed_at FROM payment_attempts a JOIN payment_intents i ON i.id=a.payment_intent_id LEFT JOIN idempotency_keys k ON k.attempt_id=a.id WHERE i.order_id=${order.body.order_id}`.execute(pg.db);
    throw new Error(`no final answer for ${order.body.order_id} (${order.source}); db: ${JSON.stringify(state.rows)}; now ${new Date().toISOString()}`);
  }

  // ---- background workers, run against live traffic -------------------------------------------------------------------

  function startWorkers() {
    const lookup = new ProcessorLookup({ baseUrl: processorBase, timeoutMs: 1000 });
    const policy = { stuckAfterMs: 150, abandonedGraceMs: 60 * 60_000 };
    const sweeper = new RecoverySweeper(pg.db, lookup, { ...policy, pendingAfterMs: 150, claimStaleAfterMs: 60_000, batchSize: 100, concurrency: 4, feeBps: 150 });
    const reconciler = new Reconciler(pg.db, lookup, { ...policy, lookbackMs: 48 * 60 * 60_000, feeBps: 150 });
    const relay = new OutboxRelay(pg.db, {
      batchSize: 50,
      maxAttempts: 10,
      leaseMs: 30_000,
      deliveryTimeoutMs: 1000,
      retry: { baseDelayMs: 30, maxDelayMs: 200, jitter: 'none' },
      urlPolicy: { allowHttp: true, allowPrivateNetworks: true },
    });
    let running = true;
    const errors: string[] = [];
    const loop = async (name: string, step: () => Promise<unknown>, everyMs: number) => {
      while (running) {
        try {
          await step();
        } catch (e) {
          errors.push(`${name}: ${String(e)}`);
        }
        await sleep(everyMs);
      }
    };
    const done = Promise.all([
      loop('sweeper', () => sweeper.runOnce(), 60),
      loop('reconciler', () => reconciler.runOnce(), 90),
      loop('relay', () => relay.runOnce(), 40),
    ]);
    return {
      errors,
      stop: async () => {
        running = false;
        await done;
      },
    };
  }

  // ---- the run -----------------------------------------------------------------------------------------------------------

  const orders: Order[] = [];
  const repliesByOrder = new Map<string, Reply[]>();
  const finalByOrder = new Map<string, Reply>();
  let workerErrors: string[] = [];
  let settledInTime = false;

  beforeAll(async () => {
    await control('POST', '/reset');
    for (const [source, { rule }] of Object.entries(SCENARIOS)) {
      if (rule) await control('POST', '/rules', { match: { source }, times: null, ...rule });
    }
    // every webhook the processor sends arrives three times, to the real receiver
    await control('PUT', '/webhook', { url: `${apiBase}/webhooks/processor`, duplicates: 2, maxRetries: 1, retryDelayMs: 20 });

    const merchants: { id: number; apiKey: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await createMerchant(pg.db);
      await pg.db.updateTable('merchants').set({ webhook_url: `${merchantBase}/hook`, webhook_secret: 'chaos-merchant-secret-123' }).where('id', '=', id).execute();
      merchants.push({ id, apiKey: await createTestApiKey(pg.db, id) });
    }
    let n = 0;
    for (const source of Object.keys(SCENARIOS) as Source[]) {
      for (let i = 0; i < ORDERS_PER_SOURCE; i++) {
        const m = merchants[n++ % merchants.length];
        orders.push({
          merchantId: m.id,
          apiKey: m.apiKey,
          key: `key-${uid()}`,
          source,
          body: { order_id: `ord_${uid()}`, amount: 1000 + 250 * (n % 7), currency: 'NGN', source },
        });
      }
    }

    const workers = startWorkers();

    // Everything at once: CLIENTS_PER_ORDER identical clients per order, plus a client that reuses the key with a different
    // amount (must be refused, never obeyed).
    await Promise.all(
      orders.flatMap((order) => {
        const replies: Reply[] = [];
        repliesByOrder.set(order.body.order_id, replies);
        const clients = Array.from({ length: CLIENTS_PER_ORDER }, async () => {
          const final = await payUntilFinal(order, replies);
          finalByOrder.set(order.body.order_id, final);
        });
        const tamperer = (async () => {
          await sleep(jitter(0, 150));
          const reply = await post(order, { ...order.body, amount: order.body.amount + 1 });
          replies.push({ ...reply, status: -reply.status }); // tagged: these must all be refusals
        })();
        return [...clients, tamperer];
      }),
    );

    // Settle: let recovery and delivery finish what the clients' retries cannot (webhooks, outbox retries).
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const open = await sql<{ n: number }>`
        SELECT (SELECT count(*) FROM payment_attempts WHERE status NOT IN ('succeeded','failed'))
             + (SELECT count(*) FROM outbox_events WHERE status <> 'delivered') AS n`.execute(pg.db);
      if (Number(open.rows[0].n) === 0) {
        settledInTime = true;
        break;
      }
      await sleep(100);
    }
    await workers.stop();
    workerErrors = workers.errors;
  }, 120_000);

  // ---- the questions ---------------------------------------------------------------------------------------------------

  const attemptsOf = async (orderId: string) =>
    sql<{ id: number; status: string; processor_idempotency_key: string; intent_status: string; amount: number }>`
      SELECT a.id, a.status, a.processor_idempotency_key, i.status AS intent_status, i.amount
      FROM payment_intents i JOIN payment_attempts a ON a.payment_intent_id = i.id
      WHERE i.order_id = ${orderId}`.execute(pg.db).then((r) => r.rows);

  it('settles: no attempt left in flight and no merchant event left undelivered', () => {
    expect(settledInTime).toBe(true);
    expect(workerErrors).toEqual([]);
  });

  it('the books are sound and every final payment told its merchant', async () => {
    expect(await checkLedgerInvariants(pg.db)).toEqual([]);
    expect(await findAttemptsMissingOutboxEvent(pg.db)).toEqual([]);
  });

  it('nothing is waiting for a human: no open reconciliation findings, no dead events', async () => {
    expect(await listOpenFindings(pg.db)).toEqual([]);
    expect(await pg.db.selectFrom('outbox_events').select('id').where('status', '=', 'dead').execute()).toEqual([]);
  });

  it('every order was charged AT MOST once at the processor, and exactly as the card dictated', async () => {
    const charges: any[] = ((await (await fetch(`${processorBase}/v1/charges`)).json()) as any).data;
    const perOrder = new Map<string, number>();
    for (const order of orders) {
      const attempts = await attemptsOf(order.body.order_id);
      const refs = new Set(attempts.map((a) => a.processor_idempotency_key));
      const mine = charges.filter((c) => refs.has(c.metadata?.reference));
      perOrder.set(order.body.order_id, mine.length);
      expect(mine.length).toBeLessThanOrEqual(1);
      // a decline is a charge object too in some processors; ours stores one per processed key, so one per attempt at most
      expect(attempts).toHaveLength(1); // 4 clients and a tamperer, one attempt
    }
    // the processor never saw a charge we do not know about
    const known = new Set((await sql<{ k: string }>`SELECT processor_idempotency_key AS k FROM payment_attempts`.execute(pg.db)).rows.map((r) => r.k));
    for (const c of charges) expect(known.has(c.metadata?.reference)).toBe(true);
  });

  it.each(Object.keys(SCENARIOS) as Source[])('%s orders end where the customer is entitled to', async (source) => {
    for (const order of orders.filter((o) => o.source === source)) {
      const [attempt] = await attemptsOf(order.body.order_id);
      expect(attempt.status).toBe(SCENARIOS[source].final);
    }
  });

  it('all clients of an order heard the same story: one payment, one final outcome, never a contradiction', () => {
    for (const order of orders) {
      const replies = repliesByOrder.get(order.body.order_id)!;
      const real = replies.filter((r) => r.status > 0);
      const ids = new Set(real.filter((r) => [201, 402, 202].includes(r.status) && r.body?.id).map((r) => r.body.id));
      expect(ids.size).toBeLessThanOrEqual(1);
      const finals = new Set(real.filter((r) => r.status === 201 || r.status === 402).map((r) => `${r.status}:${r.body?.status}`));
      expect(finals.size).toBe(1);
      const final = finalByOrder.get(order.body.order_id)!;
      expect(final.status).toBe(SCENARIOS[order.source].final === 'succeeded' ? 201 : 402);
      // the only things a client may ever have seen before the end
      for (const r of real) expect([201, 202, 402, 409, 500, 503]).toContain(r.status);
    }
  });

  it('a key reused with different details was refused every time, whatever else was happening', () => {
    for (const order of orders) {
      const tampered = repliesByOrder.get(order.body.order_id)!.filter((r) => r.status <= 0 && r.status !== 0);
      expect(tampered).toHaveLength(1);
      expect([-422, -409]).toContain(tampered[0].status);
    }
  });

  it('the merchant was told each final payment exactly once in effect: every event id arrived at least once, none invented', async () => {
    const events = await pg.db.selectFrom('outbox_events').select(['id', 'status', 'dedupe_key']).execute();
    const finalAttempts = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM payment_attempts WHERE status IN ('succeeded','failed')`.execute(pg.db)).rows[0].n;
    expect(events).toHaveLength(finalAttempts);
    expect(new Set(events.map((e) => e.dedupe_key)).size).toBe(events.length); // one event per final attempt
    for (const e of events) {
      expect(e.status).toBe('delivered');
      expect(seenEvents.get(`evt_out_${e.id}`)).toBeGreaterThanOrEqual(1);
    }
    expect(seenEvents.size).toBe(events.length); // nothing the outbox does not know about
    // the chaos was real: retries and duplicates actually happened
    expect(merchantRequests).toBeGreaterThan(events.length);
  });

  it('merchants are owed exactly what succeeded, net of the platform fee', async () => {
    const rows = (
      await sql<{ merchant_id: number; gross: string; n: number }>`
        SELECT i.merchant_id, sum(i.amount)::bigint AS gross, count(*)::int AS n
        FROM payment_attempts a JOIN payment_intents i ON i.id = a.payment_intent_id
        WHERE a.status = 'succeeded' GROUP BY i.merchant_id`.execute(pg.db)
    ).rows;
    const postings = (await sql<{ n: number }>`SELECT count(*)::int AS n FROM ledger_transactions WHERE source_type = 'payment_attempt'`.execute(pg.db)).rows[0].n;
    expect(postings).toBe(rows.reduce((s, r) => s + r.n, 0)); // one posting per success, however many ways the success was learned
    expect(rows.length).toBeGreaterThan(0);
  });

  it('paying again for an order that is already paid is refused, and nothing is charged', async () => {
    const before: any[] = ((await (await fetch(`${processorBase}/v1/charges`)).json()) as any).data;
    for (const order of orders.filter((o) => SCENARIOS[o.source].final === 'succeeded').slice(0, 8)) {
      const reply = await post(order, order.body, `key-${uid()}`);
      expect(reply.status).toBe(409);
      expect(reply.body.error.code).toBe('order_already_paid');
    }
    const after: any[] = ((await (await fetch(`${processorBase}/v1/charges`)).json()) as any).data;
    expect(after).toHaveLength(before.length);
    expect(await checkLedgerInvariants(pg.db)).toEqual([]);
  });
});

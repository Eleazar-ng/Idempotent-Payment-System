import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import { claimDueOutboxEvents, createDb, DB, applyProcessorOutcome, listDeadOutboxEvents, requeueDeadOutboxEvent } from '@app/db';
import type { Database } from '@app/db';
import { EVENT_ID_HEADER, PLATFORM_SIGNATURE_HEADER, verifyWebhook } from '@app/payments-core';
import { createAttemptInStatus, createMerchant, startMigratedPostgres, TestPostgres, uid } from '@app/testing';
import { OutboxRelay } from './outbox-relay';
import type { OutboxRelayOptions } from './outbox-relay';
import { OUTBOX_LOOP_OPTIONS, OutboxRelayService } from './outbox-relay.service';

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}
type Behaviour = (req: Received) => { status: number; headers?: Record<string, string>; delayMs?: number } | 'hang';

describe('outbox relay (real Postgres, real HTTP merchant)', () => {
  let pg: TestPostgres;
  let merchantServer: Server;
  let base: string;
  let received: Received[] = [];
  let behaviour: Behaviour = () => ({ status: 200 });
  const secret = 'merchant-secret-123456';
  // A fixed time in the future: events are written with the real clock (default next_attempt_at = now()), so the test clock must be later than that.
  let clock = new Date('2030-01-01T10:00:00Z');
  const at = (ms: number) => new Date(new Date('2030-01-01T10:00:00Z').getTime() + ms);

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    merchantServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const record: Received = { path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
        received.push(record);
        const answer = behaviour(record);
        if (answer === 'hang') return; // never answers; the relay's timeout has to cope
        setTimeout(() => {
          res.writeHead(answer.status, answer.headers);
          res.end('ok');
        }, answer.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => merchantServer.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(merchantServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    merchantServer?.closeAllConnections();
    await new Promise<void>((resolve) => merchantServer?.close(() => resolve()));
    await pg?.stop();
  });

  beforeEach(async () => {
    received = [];
    behaviour = () => ({ status: 200 });
    clock = at(0);
    await pg.db.deleteFrom('outbox_events').execute();
  });

  const options = (over: Partial<OutboxRelayOptions> = {}): OutboxRelayOptions => ({
    batchSize: 50,
    maxAttempts: 4,
    leaseMs: 60_000,
    deliveryTimeoutMs: 400,
    retry: { baseDelayMs: 1000, maxDelayMs: 60_000, jitter: 'none' },
    now: () => clock,
    random: () => 0.5,
    ...over,
  });
  const relay = (over: Partial<OutboxRelayOptions> = {}, db: Kysely<Database> = pg.db) => new OutboxRelay(db, options(over));

  async function merchantWithHook(path = '/hook') {
    const merchantId = await createMerchant(pg.db);
    await pg.db
      .updateTable('merchants')
      .set({ webhook_url: `${base}${path}`, webhook_secret: secret })
      .where('id', '=', merchantId)
      .execute();
    return merchantId;
  }

  /** A real payment event, written the real way: by finishing an attempt. */
  async function paymentEvent(merchantId?: number, outcome: 'succeeded' | 'declined' = 'succeeded') {
    const seeded = await createAttemptInStatus(pg.db, 'calling_processor', merchantId);
    await applyProcessorOutcome(
      pg.db,
      seeded.attemptId,
      outcome === 'succeeded' ? { kind: 'succeeded', chargeId: `ch_${uid()}` } : { kind: 'declined', code: 'card_declined' },
      'calling_processor',
      { feeBps: 150 },
    );
    const event = await pg.db
      .selectFrom('outbox_events')
      .selectAll()
      .where('dedupe_key', 'like', `%:attempt:${seeded.attemptId}`)
      .executeTakeFirstOrThrow();
    return { ...seeded, outboxId: event.id };
  }
  const outbox = (id: number) => pg.db.selectFrom('outbox_events').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  describe('a delivery', () => {
    it('sends a signed event the merchant can verify, then marks it delivered', async () => {
      const merchantId = await merchantWithHook('/payments');
      const { outboxId, intentId } = await paymentEvent(merchantId);

      const summary = await relay().runOnce();
      expect(summary).toEqual({ claimed: 1, delivered: 1, retried: 0, dead: 0, skipped: 0 });

      expect(received).toHaveLength(1);
      const [req] = received;
      expect(req.path).toBe('/payments');
      expect(req.headers[EVENT_ID_HEADER]).toBe(`evt_out_${outboxId}`);
      // exactly what a merchant would do: verify the signature over the raw bytes with their secret
      expect(() =>
        verifyWebhook({
          secret,
          header: req.headers[PLATFORM_SIGNATURE_HEADER] as string,
          payload: req.body,
          nowSeconds: Math.floor(clock.getTime() / 1000),
        }),
      ).not.toThrow();
      expect(JSON.parse(req.body)).toMatchObject({
        id: `evt_out_${outboxId}`,
        object: 'event',
        type: 'payment.succeeded',
        data: { object: { payment_id: `pay_${intentId}`, amount: 5000, currency: 'NGN' } },
      });
      expect(await outbox(outboxId)).toMatchObject({ status: 'delivered', attempts: 1, locked_until: null });
    });

    it('a signature made with some other secret does not verify', async () => {
      const merchantId = await merchantWithHook();
      await paymentEvent(merchantId);
      await relay().runOnce();
      expect(() =>
        verifyWebhook({
          secret: 'not-the-merchant-secret',
          header: received[0].headers[PLATFORM_SIGNATURE_HEADER] as string,
          payload: received[0].body,
          nowSeconds: Math.floor(clock.getTime() / 1000),
        }),
      ).toThrow();
    });

    it('tells the merchant about a failed payment too', async () => {
      const merchantId = await merchantWithHook();
      await paymentEvent(merchantId, 'declined');
      await relay().runOnce();
      expect(JSON.parse(received[0].body)).toMatchObject({ type: 'payment.failed', data: { object: { failure_code: 'card_declined' } } });
    });

    it('does nothing when nothing is due, and is quiet the next time', async () => {
      const merchantId = await merchantWithHook();
      await paymentEvent(merchantId);
      await relay().runOnce();
      expect(await relay().runOnce()).toEqual({ claimed: 0, delivered: 0, retried: 0, dead: 0, skipped: 0 });
      expect(received).toHaveLength(1);
    });

    it('skips an event for a merchant with no webhook URL', async () => {
      const merchantId = await createMerchant(pg.db);
      const { outboxId } = await paymentEvent(merchantId);
      expect(await relay().runOnce()).toMatchObject({ skipped: 1, delivered: 0 });
      expect(await outbox(outboxId)).toMatchObject({ status: 'skipped', last_error: 'no_webhook_url' });
      expect(received).toHaveLength(0);
    });
  });

  describe('when the merchant is having trouble', () => {
    it('retries later with a pause from the policy, sending the identical body each time', async () => {
      const merchantId = await merchantWithHook();
      const { outboxId } = await paymentEvent(merchantId);
      behaviour = () => ({ status: 500 });

      expect(await relay().runOnce()).toMatchObject({ retried: 1 });
      expect(await outbox(outboxId)).toMatchObject({ status: 'pending', attempts: 1, last_error: 'http_500', next_attempt_at: at(1000) });

      clock = at(999);
      expect(await relay().runOnce()).toMatchObject({ claimed: 0 }); // not yet
      clock = at(1000);
      expect(await relay().runOnce()).toMatchObject({ retried: 1 });
      expect(await outbox(outboxId)).toMatchObject({ attempts: 2, next_attempt_at: at(1000 + 2000) }); // grew

      behaviour = () => ({ status: 200 });
      clock = at(3000);
      expect(await relay().runOnce()).toMatchObject({ delivered: 1 });
      expect(await outbox(outboxId)).toMatchObject({ status: 'delivered', attempts: 3, last_error: null });

      expect(received).toHaveLength(3);
      expect(new Set(received.map((r) => r.body)).size).toBe(1); // same bytes every time
      expect(new Set(received.map((r) => r.headers[EVENT_ID_HEADER])).size).toBe(1); // same event id every time
    });

    it('honours Retry-After when it asks for longer than the policy would', async () => {
      const merchantId = await merchantWithHook();
      const { outboxId } = await paymentEvent(merchantId);
      behaviour = () => ({ status: 503, headers: { 'retry-after': '30' } });
      await relay().runOnce();
      expect((await outbox(outboxId)).next_attempt_at).toEqual(at(30_000));
    });

    it('does not let Retry-After park an event beyond the policy maximum', async () => {
      const merchantId = await merchantWithHook();
      const { outboxId } = await paymentEvent(merchantId);
      behaviour = () => ({ status: 429, headers: { 'retry-after': '86400' } });
      await relay().runOnce();
      expect((await outbox(outboxId)).next_attempt_at).toEqual(at(60_000));
    });

    it('treats a timeout as a failure to retry, not as a success', async () => {
      const merchantId = await merchantWithHook();
      const { outboxId } = await paymentEvent(merchantId);
      behaviour = () => 'hang';
      expect(await relay({ deliveryTimeoutMs: 150 }).runOnce()).toMatchObject({ retried: 1 });
      expect(await outbox(outboxId)).toMatchObject({ status: 'pending', last_error: 'timeout' });
    });

    it('treats a refused connection as a failure to retry', async () => {
      const merchantId = await createMerchant(pg.db);
      await pg.db.updateTable('merchants').set({ webhook_url: 'http://127.0.0.1:1/nope', webhook_secret: secret }).where('id', '=', merchantId).execute();
      const { outboxId } = await paymentEvent(merchantId);
      expect(await relay().runOnce()).toMatchObject({ retried: 1 });
      expect((await outbox(outboxId)).last_error).toMatch(/^network:/);
    });

    it('does not follow a redirect', async () => {
      const merchantId = await merchantWithHook();
      const { outboxId } = await paymentEvent(merchantId);
      behaviour = (req) => (req.path === '/hook' ? { status: 302, headers: { location: `${base}/elsewhere` } } : { status: 200 });
      await relay().runOnce();
      expect(received.map((r) => r.path)).toEqual(['/hook']);
      expect(await outbox(outboxId)).toMatchObject({ status: 'pending', last_error: 'http_302' });
    });

    it('gives up after the maximum attempts, parks the event as dead, and can be requeued once the merchant is fixed', async () => {
      const merchantId = await merchantWithHook();
      const { outboxId } = await paymentEvent(merchantId);
      behaviour = () => ({ status: 500 });
      const r = relay({ maxAttempts: 3 });

      expect(await r.runOnce()).toMatchObject({ retried: 1 });
      clock = at(1000);
      expect(await r.runOnce()).toMatchObject({ retried: 1 });
      clock = at(10_000);
      expect(await r.runOnce()).toMatchObject({ dead: 1 });

      expect(await outbox(outboxId)).toMatchObject({ status: 'dead', attempts: 3, last_error: 'http_500' });
      expect((await listDeadOutboxEvents(pg.db)).map((e) => e.id)).toEqual([outboxId]);
      clock = at(100_000);
      expect(await r.runOnce()).toMatchObject({ claimed: 0 }); // dead means dead: no more tries

      behaviour = () => ({ status: 200 });
      await requeueDeadOutboxEvent(pg.db, outboxId, clock);
      expect(await r.runOnce()).toMatchObject({ delivered: 1 });
      expect(await outbox(outboxId)).toMatchObject({ status: 'delivered', attempts: 1 });
    });

    it('spreads retries out: different jitter draws give different next times', async () => {
      const merchantId = await merchantWithHook();
      const a = await paymentEvent(merchantId);
      const b = await paymentEvent(merchantId);
      behaviour = () => ({ status: 500 });
      const draws = [0.1, 0.9];
      await relay({ retry: { baseDelayMs: 10_000, maxDelayMs: 60_000 }, random: () => draws.shift() as number }).runOnce();
      const times = [(await outbox(a.outboxId)).next_attempt_at.getTime(), (await outbox(b.outboxId)).next_attempt_at.getTime()];
      expect(new Set(times).size).toBe(2);
      for (const t of times) {
        expect(t).toBeGreaterThanOrEqual(at(0).getTime());
        expect(t).toBeLessThanOrEqual(at(10_000).getTime());
      }
    });
  });

  describe('many events and many workers', () => {
    it('a merchant that hangs does not hold up the others (events go out concurrently)', async () => {
      const slow = await merchantWithHook('/slow');
      const fast = await merchantWithHook('/fast');
      for (let i = 0; i < 4; i++) await paymentEvent(slow);
      for (let i = 0; i < 4; i++) await paymentEvent(fast);
      behaviour = (req) => (req.path === '/slow' ? 'hang' : { status: 200 });

      const started = Date.now();
      const summary = await relay({ deliveryTimeoutMs: 500 }).runOnce();
      const elapsed = Date.now() - started;

      expect(summary).toMatchObject({ claimed: 8, delivered: 4, retried: 4 });
      expect(elapsed).toBeLessThan(500 * 3); // one timeout, not four in a row
    });

    it('three relays at once deliver every event exactly once', async () => {
      const merchantId = await merchantWithHook();
      const ids: number[] = [];
      for (let i = 0; i < 18; i++) ids.push((await paymentEvent(merchantId)).outboxId);

      const summaries = await Promise.all([0, 1, 2].map(() => relay({ batchSize: 7 }).runOnce()));
      await relay({ batchSize: 50 }).runOnce(); // sweep up anything the first round did not reach

      const perEvent = new Map<string, number>();
      for (const r of received) perEvent.set(r.headers[EVENT_ID_HEADER] as string, (perEvent.get(r.headers[EVENT_ID_HEADER] as string) ?? 0) + 1);
      expect(perEvent.size).toBe(18);
      expect([...perEvent.values()].every((n) => n === 1)).toBe(true);
      expect(summaries.reduce((n, s) => n + s.claimed, 0)).toBeGreaterThan(0);
    });

    it('recovers events claimed by a worker that died: nothing before the lease ends, then delivered', async () => {
      const merchantId = await merchantWithHook();
      const { outboxId } = await paymentEvent(merchantId);
      // The "dead worker": claims, then vanishes without delivering or recording anything.
      await claimDueOutboxEvents(pg.db, { now: at(0), limit: 10, leaseMs: 60_000 });

      clock = at(30_000);
      expect(await relay().runOnce()).toMatchObject({ claimed: 0 });
      clock = at(61_000);
      expect(await relay().runOnce()).toMatchObject({ delivered: 1 });
      expect(await outbox(outboxId)).toMatchObject({ status: 'delivered', attempts: 2 });
      expect(received).toHaveLength(1);
    });

    it('refuses a lease that is not longer than the delivery timeout', () => {
      expect(() => relay({ leaseMs: 400, deliveryTimeoutMs: 400 })).toThrow(/leaseMs/);
    });
  });

  describe('the worker application', () => {
    it('runs the relay in the background and stops cleanly', async () => {
      const merchantId = await merchantWithHook();
      const { outboxId } = await paymentEvent(merchantId);
      const db = createDb(pg.connectionString, { maxConnections: 5 });
      const moduleRef = await Test.createTestingModule({
        providers: [
          { provide: DB, useValue: db },
          {
            provide: OUTBOX_LOOP_OPTIONS,
            useValue: { pollIntervalMs: 50, relay: { ...options(), now: undefined, random: undefined } },
          },
          OutboxRelayService,
        ],
      }).compile();
      const app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (await outbox(outboxId)).status !== 'delivered') {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect((await outbox(outboxId)).status).toBe('delivered');

      await app.close(); // must resolve: the loop notices the stop flag
      await db.destroy();
    });
  });
});

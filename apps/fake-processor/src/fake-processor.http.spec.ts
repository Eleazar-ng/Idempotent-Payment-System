import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { verifyWebhook, WEBHOOK_SIGNATURE_HEADER } from '@app/payments-core';
import { FakeProcessorModule } from './fake-processor.module';
import { sleep, startReceiver, uid } from './test-helpers';

/**
 * End to end over real sockets: the same wire-level view our payment code will have. This is where
 * "the connection closed with no response" and "the client gave up waiting" are real, not simulated.
 * Env vars (including the webhook secret) come from jest.setup-env.js.
 */
describe('fake processor over HTTP', () => {
  let app: NestExpressApplication;
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [FakeProcessorModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await control('POST', '/reset');
  });

  async function control(method: string, path: string, json?: unknown) {
    const res = await fetch(`${base}/_control${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  const reference = () => `ord_${uid()}`;
  const chargeBody = (ref = reference(), over: Record<string, unknown> = {}) => ({
    amount: 5000,
    currency: 'NGN',
    metadata: { reference: ref },
    ...over,
  });

  function postCharge(key: string | undefined, body: unknown, init: RequestInit = {}) {
    return fetch(`${base}/v1/charges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...init,
    });
  }

  const listCharges = async (ref?: string) =>
    ((await (await fetch(`${base}/v1/charges${ref ? `?reference=${ref}` : ''}`)).json()) as { data: { id: string; status: string }[] }).data;

  it('answers the liveness probe', async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  describe('charges and idempotency', () => {
    it('creates a charge, then replays it on the same key with a replay header', async () => {
      const body = chargeBody();
      const first = await postCharge('k1', body);
      const second = await postCharge('k1', body);

      expect(first.status).toBe(200);
      expect(first.headers.get('idempotent-replayed')).toBeNull();
      expect(second.headers.get('idempotent-replayed')).toBe('true');
      expect(await second.json()).toEqual(await first.json());
      expect(await listCharges()).toHaveLength(1);
    });

    it('a reused key with different parameters is a 400', async () => {
      await postCharge('k1', chargeBody(undefined, { amount: 100 }));
      const res = await postCharge('k1', chargeBody(undefined, { amount: 200 }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.code).toBe('idempotency_key_reused'); // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    it('requires an Idempotency-Key header', async () => {
      const res = await postCharge(undefined, chargeBody());
      expect(res.status).toBe(400);
    });

    it('rejects malformed JSON with a 400 and creates nothing', async () => {
      const res = await postCharge('k1', '{ not json');
      expect(res.status).toBe(400);
      expect(await listCharges()).toHaveLength(0);
    });

    it('serves a declined card as a 402', async () => {
      const res = await postCharge('k1', chargeBody(undefined, { source: 'tok_declined' }));
      expect(res.status).toBe(402);
      expect(((await res.json()) as any).error.code).toBe('card_declined'); // eslint-disable-line @typescript-eslint/no-explicit-any
    });

    it('answers 409 to a concurrent duplicate while the first is in progress, then replays', async () => {
      await control('POST', '/rules', { processingDelayMs: 300 });
      const body = chargeBody();

      const first = postCharge('k1', body);
      await sleep(80);
      const concurrent = await postCharge('k1', body);
      expect(concurrent.status).toBe(409);

      expect((await first).status).toBe(200);
      expect((await postCharge('k1', body)).headers.get('idempotent-replayed')).toBe('true');
      expect(await listCharges()).toHaveLength(1);
    });

    it('retrieves a charge by id; unknown ids are 404', async () => {
      const made = (await (await postCharge('k1', chargeBody())).json()) as { id: string };
      const got = await fetch(`${base}/v1/charges/${made.id}`);
      expect(got.status).toBe(200);
      expect(((await got.json()) as { id: string }).id).toBe(made.id);
      expect((await fetch(`${base}/v1/charges/ch_nope`)).status).toBe(404);
    });
  });

  describe('lost responses, as the caller experiences them', () => {
    it('drop_after: the caller sees a connection error, the charge exists, the retry is a replay', async () => {
      await control('POST', '/rules', { fault: 'drop_after' });
      const body = chargeBody();

      await expect(postCharge('k1', body)).rejects.toThrow(); // no response at all
      expect(await listCharges()).toHaveLength(1); // yet the money moved

      const retry = await postCharge('k1', body);
      expect(retry.status).toBe(200);
      expect(retry.headers.get('idempotent-replayed')).toBe('true');
      expect(await listCharges()).toHaveLength(1);
    });

    it('drop_before: the caller sees a connection error and there is no charge', async () => {
      await control('POST', '/rules', { fault: 'drop_before' });
      await expect(postCharge('k1', chargeBody())).rejects.toThrow();
      expect(await listCharges()).toHaveLength(0);
    });

    it('error_after: a 500 for a charge that succeeded', async () => {
      await control('POST', '/rules', { fault: 'error_after' });
      const body = chargeBody();
      expect((await postCharge('k1', body)).status).toBe(500);
      expect(await listCharges()).toHaveLength(1);
      expect((await postCharge('k1', body)).status).toBe(200);
      expect(await listCharges()).toHaveLength(1);
    });

    it('gateway_error: a 503 and no charge', async () => {
      await control('POST', '/rules', { fault: 'gateway_error' });
      expect((await postCharge('k1', chargeBody())).status).toBe(503);
      expect(await listCharges()).toHaveLength(0);
    });

    it('a client timeout: the caller gives up waiting, the charge exists anyway (Module 2.2)', async () => {
      await control('POST', '/rules', { responseDelayMs: 400 });
      const body = chargeBody();

      await expect(postCharge('k1', body, { signal: AbortSignal.timeout(100) })).rejects.toThrow();
      expect(await listCharges()).toHaveLength(1);

      const retry = await postCharge('k1', body);
      expect(retry.headers.get('idempotent-replayed')).toBe('true');
      expect(await listCharges()).toHaveLength(1);
    });

    it('reconciliation can find the charge by reference when the id was never received', async () => {
      await control('POST', '/rules', { fault: 'drop_after' });
      const ref = reference();
      await expect(postCharge('k1', chargeBody(ref))).rejects.toThrow();

      const found = await listCharges(ref);
      expect(found).toHaveLength(1);
      expect(found[0].status).toBe('succeeded');
    });
  });

  describe('control API', () => {
    it('validates rules', async () => {
      expect((await control('POST', '/rules', {})).status).toBe(400); // does nothing
      expect((await control('POST', '/rules', { fault: 'explode' })).status).toBe(400);
      expect((await control('POST', '/rules', { outcome: 'succeed', times: 0 })).status).toBe(400);
      expect((await control('POST', '/rules', { responseDelayMs: -1 })).status).toBe(400);
    });

    it('lists and clears rules', async () => {
      await control('POST', '/rules', { fault: 'gateway_error' });
      expect((await control('GET', '/rules')).body.data).toHaveLength(1);
      expect((await control('DELETE', '/rules')).status).toBe(204);
      expect((await control('GET', '/rules')).body.data).toHaveLength(0);
    });

    it('moves the clock forward so a key expires', async () => {
      const body = chargeBody();
      await postCharge('k1', body);
      await control('POST', '/clock/advance', { ms: 25 * 60 * 60 * 1000 });
      const late = await postCharge('k1', body);
      expect(late.headers.get('idempotent-replayed')).toBeNull();
      expect(await listCharges()).toHaveLength(2);
    });

    it('resolves a pending charge, and refuses to resolve it twice', async () => {
      const made = (await (await postCharge('k1', chargeBody(undefined, { source: 'tok_pending' }))).json()) as { id: string };

      const ok = await control('POST', `/charges/${made.id}/resolve`, { outcome: 'succeeded' });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('succeeded');
      expect((await control('POST', `/charges/${made.id}/resolve`, { outcome: 'failed' })).status).toBe(409);
      expect((await control('POST', '/charges/ch_nope/resolve', { outcome: 'failed' })).status).toBe(404);
      expect((await control('POST', `/charges/${made.id}/resolve`, { outcome: 'maybe' })).status).toBe(400);
    });

    it('reports stats', async () => {
      await postCharge('k1', chargeBody());
      await postCharge('k2', chargeBody(undefined, { source: 'tok_declined' }));
      expect((await control('GET', '/stats')).body).toEqual({
        charges: 2,
        idempotencyKeys: 2,
        replays: 0,
        byStatus: { succeeded: 1, failed: 1 },
      });
    });
  });

  describe('webhooks end to end', () => {
    let receiver: Awaited<ReturnType<typeof startReceiver>>;

    beforeEach(async () => {
      receiver = await startReceiver();
      await control('PUT', '/webhook', { url: receiver.url, retryDelayMs: 5 });
    });

    afterEach(async () => {
      await receiver.stop();
    });

    const eventsOnWire = async () => {
      await control('GET', '/events'); // waits for in-progress deliveries
      return receiver.received.map((r) => JSON.parse(r.body) as { id: string; type: string; data: { object: { id: string; status: string } } });
    };

    it('sends a verified charge.succeeded when a charge succeeds', async () => {
      const made = (await (await postCharge('k1', chargeBody())).json()) as { id: string };
      const [event] = await eventsOnWire();

      expect(event).toMatchObject({ type: 'charge.succeeded', data: { object: { id: made.id } } });
      expect(() =>
        verifyWebhook({
          secret: process.env.PROCESSOR_WEBHOOK_SECRET as string,
          header: receiver.received[0].headers[WEBHOOK_SIGNATURE_HEADER] as string,
          payload: receiver.received[0].body,
        }),
      ).not.toThrow();
    });

    it('a pending charge sends nothing until it is resolved', async () => {
      const made = (await (await postCharge('k1', chargeBody(undefined, { source: 'tok_pending' }))).json()) as { id: string };
      expect(await eventsOnWire()).toHaveLength(0);

      await control('POST', `/charges/${made.id}/resolve`, { outcome: 'succeeded' });
      const events = await eventsOnWire();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'charge.succeeded', data: { object: { id: made.id, status: 'succeeded' } } });
    });

    it('the lost-response scenario still produces the webhook: the processor tells us even when the HTTP reply was lost', async () => {
      await control('POST', '/rules', { fault: 'drop_after' });
      await expect(postCharge('k1', chargeBody())).rejects.toThrow();
      expect(await eventsOnWire()).toHaveLength(1);
    });

    it('duplicates, then a held and reversed flush, then a manual redelivery', async () => {
      await control('PUT', '/webhook', { duplicates: 1, mode: 'hold' });
      await postCharge('k1', chargeBody());
      await postCharge('k2', chargeBody());
      expect(await eventsOnWire()).toHaveLength(0);

      expect((await control('POST', '/webhook/flush', { order: 'reverse' })).body).toEqual({ delivered: 2 });
      const events = await eventsOnWire();
      expect(events).toHaveLength(4); // 2 events x 2 copies
      expect(events[0].id).toBe(events[1].id);
      expect(events[2].id).toBe(events[3].id);
      expect(events[0].id).not.toBe(events[2].id);

      const listed = (await control('GET', '/events')).body.data as { id: string }[];
      expect(listed.map((e) => e.id).reverse()).toEqual([events[0].id, events[2].id]); // delivered newest first

      expect((await control('POST', `/events/${listed[0].id}/redeliver`)).status).toBe(200);
      expect((await control('POST', '/events/evt_nope/redeliver')).status).toBe(404);
    });

    it('validates webhook settings', async () => {
      expect((await control('PUT', '/webhook', { url: 'not a url' })).status).toBe(400);
      expect((await control('PUT', '/webhook', { duplicates: 99 })).status).toBe(400);
      expect((await control('PUT', '/webhook', { mode: 'sideways' })).status).toBe(400);
      expect((await control('POST', '/webhook/flush', { order: 'random' })).status).toBe(400);
    });
  });
});

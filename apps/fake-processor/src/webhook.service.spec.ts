import { verifyWebhook, WEBHOOK_SIGNATURE_HEADER } from '@app/payments-core';
import { fakeConfig, startReceiver, WEBHOOK_SECRET } from './test-helpers';
import { WebhookService } from './webhook.service';

const charge = (id: string) => ({ id, object: 'charge', status: 'succeeded' });
const idOf = (body: string) => (JSON.parse(body) as { id: string }).id;
const chargeIdOf = (body: string) => (JSON.parse(body) as { data: { object: { id: string } } }).data.object.id;

describe('WebhookService (4.3)', () => {
  let receiver: Awaited<ReturnType<typeof startReceiver>>;

  afterEach(async () => {
    await receiver?.stop();
  });

  async function setup(respondWith?: (n: number) => number) {
    receiver = await startReceiver(respondWith);
    const service = new WebhookService(fakeConfig());
    service.configure({ url: receiver.url, retryDelayMs: 5 });
    return service;
  }

  it('delivers a signed event that our verification accepts, byte for byte', async () => {
    const service = await setup();
    const event = service.emit('charge.succeeded', charge('ch_1'));
    await service.idle();

    expect(receiver.received).toHaveLength(1);
    const [hit] = receiver.received;
    expect(hit.body).toBe(event.body);
    expect(() =>
      verifyWebhook({
        secret: WEBHOOK_SECRET,
        header: hit.headers[WEBHOOK_SIGNATURE_HEADER] as string,
        payload: hit.body,
      }),
    ).not.toThrow();
    expect(JSON.parse(hit.body)).toMatchObject({
      id: event.id,
      object: 'event',
      type: 'charge.succeeded',
      data: { object: { id: 'ch_1' } },
    });
  });

  it('is signed with the secret, so a receiver with another secret rejects it', async () => {
    const service = await setup();
    service.emit('charge.succeeded', charge('ch_1'));
    await service.idle();
    const [hit] = receiver.received;
    expect(() =>
      verifyWebhook({ secret: 'some-other-secret', header: hit.headers[WEBHOOK_SIGNATURE_HEADER] as string, payload: hit.body }),
    ).toThrow(/signature_mismatch/);
  });

  it('with no URL configured it stores the event and sends nothing', async () => {
    receiver = await startReceiver();
    const service = new WebhookService(fakeConfig());
    service.emit('charge.succeeded', charge('ch_1'));
    await service.idle();
    expect(receiver.received).toHaveLength(0);
    expect(service.listEvents()).toHaveLength(1);
    expect(service.listEvents()[0].deliveries).toEqual([]);
  });

  it('takes its starting URL from config', async () => {
    receiver = await startReceiver();
    const service = new WebhookService(fakeConfig({ FAKE_PROCESSOR_WEBHOOK_URL: receiver.url }));
    expect(service.getSettings().url).toBe(receiver.url);
  });

  describe('duplicates (at-least-once delivery)', () => {
    it('sends 1 + duplicates copies of the SAME event, each freshly signed', async () => {
      const service = await setup();
      service.configure({ duplicates: 2 });
      service.emit('charge.succeeded', charge('ch_1'));
      await service.idle();

      expect(receiver.received).toHaveLength(3);
      expect(new Set(receiver.received.map((r) => idOf(r.body))).size).toBe(1);
      expect(new Set(receiver.received.map((r) => r.body)).size).toBe(1);
      for (const hit of receiver.received) {
        expect(() =>
          verifyWebhook({ secret: WEBHOOK_SECRET, header: hit.headers[WEBHOOK_SIGNATURE_HEADER] as string, payload: hit.body }),
        ).not.toThrow();
      }
    });
  });

  describe('retries after a failed delivery', () => {
    it('retries until the receiver accepts', async () => {
      const service = await setup((n) => (n < 3 ? 500 : 200));
      const event = service.emit('charge.succeeded', charge('ch_1'));
      await service.idle();

      expect(receiver.received).toHaveLength(3);
      expect(event.deliveries.map((d) => d.status)).toEqual([500, 500, 200]);
    });

    it('gives up after maxRetries and keeps the event so it can be redelivered', async () => {
      const service = await setup(() => 503);
      service.configure({ maxRetries: 2 });
      const event = service.emit('charge.succeeded', charge('ch_1'));
      await service.idle();

      expect(receiver.received).toHaveLength(3); // 1 + 2 retries
      expect(event.deliveries.every((d) => d.status === 503)).toBe(true);
      expect(service.listEvents()).toHaveLength(1);
    });

    it('records a connection failure as an error, not a status', async () => {
      const service = new WebhookService(fakeConfig());
      service.configure({ url: 'http://127.0.0.1:1/unreachable', maxRetries: 1, retryDelayMs: 1 });
      const event = service.emit('charge.succeeded', charge('ch_1'));
      await service.idle();
      expect(event.deliveries).toHaveLength(2);
      expect(event.deliveries.every((d) => d.error !== undefined && d.status === undefined)).toBe(true);
    });

    it('does not retry a 2xx, whatever the code', async () => {
      const service = await setup(() => 204);
      service.emit('charge.succeeded', charge('ch_1'));
      await service.idle();
      expect(receiver.received).toHaveLength(1);
    });
  });

  describe('hold and flush (out-of-order delivery)', () => {
    async function heldService() {
      const service = await setup();
      service.configure({ mode: 'hold' });
      service.emit('charge.pending', charge('ch_A'));
      service.emit('charge.succeeded', charge('ch_B'));
      service.emit('charge.failed', charge('ch_C'));
      await service.idle();
      return service;
    }

    it('sends nothing while events are held', async () => {
      await heldService();
      expect(receiver.received).toHaveLength(0);
    });

    it('flushes in the order the events happened', async () => {
      const service = await heldService();
      expect(await service.flush('fifo')).toBe(3);
      expect(receiver.received.map((r) => chargeIdOf(r.body))).toEqual(['ch_A', 'ch_B', 'ch_C']);
    });

    it('flushes in reverse, so a "succeeded" can arrive before the "pending" that preceded it', async () => {
      const service = await heldService();
      await service.flush('reverse');
      expect(receiver.received.map((r) => chargeIdOf(r.body))).toEqual(['ch_C', 'ch_B', 'ch_A']);
    });

    it('flushes each event once; a second flush has nothing to do', async () => {
      const service = await heldService();
      await service.flush();
      expect(await service.flush()).toBe(0);
      expect(receiver.received).toHaveLength(3);
    });

    it('resumes immediate delivery when switched back', async () => {
      const service = await heldService();
      service.configure({ mode: 'immediate' });
      service.emit('charge.succeeded', charge('ch_D'));
      await service.idle();
      expect(receiver.received.map((r) => chargeIdOf(r.body))).toEqual(['ch_D']);
    });
  });

  describe('redelivery', () => {
    it('resends the identical event on request', async () => {
      const service = await setup();
      const event = service.emit('charge.succeeded', charge('ch_1'));
      await service.idle();

      expect(await service.redeliver(event.id)).toBe(true);
      expect(receiver.received).toHaveLength(2);
      expect(receiver.received[1].body).toBe(receiver.received[0].body);
    });

    it('says so for an unknown event', async () => {
      const service = await setup();
      expect(await service.redeliver('evt_nope')).toBe(false);
    });
  });

  it('reset forgets events and returns to the configured defaults', async () => {
    const service = await setup();
    service.configure({ mode: 'hold', duplicates: 3 });
    service.emit('charge.succeeded', charge('ch_1'));
    service.reset();
    expect(service.listEvents()).toEqual([]);
    expect(service.getSettings()).toMatchObject({ mode: 'immediate', duplicates: 0, url: null });
  });
});

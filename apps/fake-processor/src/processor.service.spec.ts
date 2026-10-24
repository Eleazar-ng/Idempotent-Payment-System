import { IDEMPOTENCY_WINDOW_MS, ProcessorService } from './processor.service';
import type { Exchange } from './processor.service';
import { fakeConfig, sleep, uid } from './test-helpers';
import { WebhookService } from './webhook.service';

function setup() {
  const webhooks = new WebhookService(fakeConfig());
  const processor = new ProcessorService(webhooks);
  return { webhooks, processor };
}

const body = (over: Record<string, unknown> = {}) => ({
  amount: 5000,
  currency: 'NGN',
  metadata: { reference: `ord_${uid()}` },
  ...over,
});

const bodyOf = (e: Exchange) => e.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('fake processor: charges and the idempotency window (4.1)', () => {
  it('creates a charge and answers with a Stripe-shaped object', async () => {
    const { processor } = setup();
    const exchange = await processor.createCharge('key-1', body({ amount: 1234 }));

    expect(exchange).toMatchObject({ action: 'respond', status: 200, responseDelayMs: 0 });
    expect(bodyOf(exchange)).toMatchObject({
      object: 'charge',
      amount: 1234,
      currency: 'NGN',
      status: 'succeeded',
      failure_code: null,
    });
    expect(bodyOf(exchange).id).toMatch(/^ch_[0-9a-f]{16}$/);
    expect(exchange.headers).toEqual({});
  });

  it.each([
    ['no Idempotency-Key', undefined, body(), 'idempotency_key_required'],
    ['an empty key', '', body(), 'idempotency_key_required'],
    ['a 256-character key', 'x'.repeat(256), body(), 'idempotency_key_required'],
    ['a zero amount', 'k', body({ amount: 0 }), 'parameter_invalid'],
    ['a fractional amount', 'k', body({ amount: 10.5 }), 'parameter_invalid'],
    ['a string amount', 'k', body({ amount: '5000' }), 'parameter_invalid'],
    ['a lowercase currency', 'k', body({ currency: 'ngn' }), 'parameter_invalid'],
    ['no body', 'k', undefined, 'parameter_invalid'],
  ])('refuses %s with a 400 and creates nothing', async (_name, key, payload, code) => {
    const { processor } = setup();
    const exchange = await processor.createCharge(key, payload);
    expect(exchange.status).toBe(400);
    expect(bodyOf(exchange).error.code).toBe(code);
    expect(processor.stats().charges).toBe(0);
  });

  describe('the idempotency window', () => {
    it('replays the stored response for the same key and parameters, and creates no second charge', async () => {
      const { processor } = setup();
      const payload = body();
      const first = await processor.createCharge('key-1', payload);
      const second = await processor.createCharge('key-1', payload);

      expect(second.status).toBe(first.status);
      expect(second.body).toEqual(first.body);
      expect(second.headers).toEqual({ 'Idempotent-Replayed': 'true' });
      expect(first.headers).toEqual({});
      expect(processor.stats()).toMatchObject({ charges: 1, replays: 1 });
    });

    it('treats reordered but identical parameters as the same request', async () => {
      const { processor } = setup();
      const first = await processor.createCharge('key-1', { amount: 100, currency: 'NGN', metadata: { a: '1', b: '2' } });
      const second = await processor.createCharge('key-1', { metadata: { b: '2', a: '1' }, currency: 'NGN', amount: 100 });
      expect(second.body).toEqual(first.body);
      expect(processor.stats().charges).toBe(1);
    });

    it('treats the default source as the same as stating it', async () => {
      const { processor } = setup();
      await processor.createCharge('key-1', { amount: 100, currency: 'NGN' });
      const again = await processor.createCharge('key-1', { amount: 100, currency: 'NGN', source: 'tok_default', metadata: {} });
      expect(again.headers['Idempotent-Replayed']).toBe('true');
    });

    it('refuses the same key with different parameters, and creates nothing', async () => {
      const { processor } = setup();
      await processor.createCharge('key-1', body({ amount: 100 }));
      const second = await processor.createCharge('key-1', body({ amount: 200 }));

      expect(second.status).toBe(400);
      expect(bodyOf(second).error).toMatchObject({ type: 'idempotency_error', code: 'idempotency_key_reused' });
      expect(processor.stats().charges).toBe(1);
    });

    it('answers 409 while the first request with that key is still being processed', async () => {
      const { processor } = setup();
      const payload = body();
      processor.addRule({ match: {}, processingDelayMs: 200, times: 1 });

      const first = processor.createCharge('key-1', payload);
      await sleep(30);
      const concurrent = await processor.createCharge('key-1', payload);
      expect(concurrent.status).toBe(409);
      expect(bodyOf(concurrent).error.code).toBe('idempotency_key_in_use');

      const firstDone = await first;
      expect(firstDone.status).toBe(200);
      expect((await processor.createCharge('key-1', payload)).headers['Idempotent-Replayed']).toBe('true');
      expect(processor.stats().charges).toBe(1);
    });

    it('forgets a key after 24 hours, so a late retry creates a SECOND charge (why retries must stop in time)', async () => {
      const { processor } = setup();
      const payload = body();
      const first = await processor.createCharge('key-1', payload);

      processor.advanceClock(IDEMPOTENCY_WINDOW_MS - 1000);
      expect((await processor.createCharge('key-1', payload)).headers['Idempotent-Replayed']).toBe('true');

      processor.advanceClock(2000);
      const late = await processor.createCharge('key-1', payload);
      expect(late.headers['Idempotent-Replayed']).toBeUndefined();
      expect(bodyOf(late).id).not.toBe(bodyOf(first).id);
      expect(processor.stats().charges).toBe(2); // the money moved twice
    });

    it('scopes keys globally, not per customer: two requests sharing a key collide', async () => {
      const { processor } = setup();
      await processor.createCharge('shared', body({ amount: 100 }));
      const other = await processor.createCharge('shared', body({ amount: 100 })); // different reference
      expect(other.status).toBe(400);
    });
  });

  describe('retrieval', () => {
    it('retrieves a charge by id and lists by reference', async () => {
      const { processor } = setup();
      const payload = body();
      const made = bodyOf(await processor.createCharge('k1', payload));
      await processor.createCharge('k2', body());

      expect(processor.getCharge(made.id)).toMatchObject({ id: made.id, status: 'succeeded' });
      expect(processor.getCharge('ch_missing')).toBeUndefined();
      expect(processor.listCharges()).toHaveLength(2);
      expect(processor.listCharges({ reference: payload.metadata.reference }).map((c) => c.id)).toEqual([made.id]);
      expect(processor.listCharges({ reference: 'nope' })).toEqual([]);
    });

    it('returns copies, so callers cannot edit the processor’s records', async () => {
      const { processor } = setup();
      const made = bodyOf(await processor.createCharge('k1', body()));
      processor.getCharge(made.id)!.status = 'failed';
      expect(processor.getCharge(made.id)!.status).toBe('succeeded');
    });
  });
});

describe('fake processor: outcomes (4.2)', () => {
  it('a decline is a 402 card_error, is recorded as a failed charge, and replays as the same 402', async () => {
    const { processor } = setup();
    const payload = body({ source: 'tok_declined' });
    const first = await processor.createCharge('k', payload);

    expect(first.status).toBe(402);
    expect(bodyOf(first).error).toMatchObject({ type: 'card_error', code: 'card_declined' });
    const chargeId = bodyOf(first).error.charge as string;
    expect(processor.getCharge(chargeId)).toMatchObject({ status: 'failed', failure_code: 'card_declined' });

    const replay = await processor.createCharge('k', payload);
    expect(replay.status).toBe(402);
    expect(replay.body).toEqual(first.body);
    expect(processor.stats().charges).toBe(1);
  });

  it.each([
    ['tok_declined', 402, 'failed', 'card_declined'],
    ['tok_insufficient_funds', 402, 'failed', 'insufficient_funds'],
    ['tok_requires_action', 200, 'requires_action', null],
    ['tok_pending', 200, 'pending', null],
    ['tok_visa', 200, 'succeeded', null],
  ])('the magic source %s gives %i / %s', async (source, httpStatus, status, failureCode) => {
    const { processor } = setup();
    const exchange = await processor.createCharge('k', body({ source }));
    expect(exchange.status).toBe(httpStatus);
    const charge = processor.listCharges()[0];
    expect(charge).toMatchObject({ status, failure_code: failureCode });
  });

  it('a rule can force an outcome and a custom decline code', async () => {
    const { processor } = setup();
    processor.addRule({ match: {}, outcome: 'decline', declineCode: 'expired_card', times: 1 });
    const exchange = await processor.createCharge('k', body());
    expect(bodyOf(exchange).error.code).toBe('expired_card');
  });

  it('an outcome rule beats the magic source', async () => {
    const { processor } = setup();
    processor.addRule({ match: {}, outcome: 'succeed', times: 1 });
    const exchange = await processor.createCharge('k', body({ source: 'tok_declined' }));
    expect(exchange.status).toBe(200);
  });
});

describe('fake processor: rules (4.2)', () => {
  it('apply once by default, then the processor recovers (fail once, then succeed)', async () => {
    const { processor } = setup();
    processor.addRule({ match: {}, fault: 'gateway_error' });
    expect((await processor.createCharge('k1', body())).status).toBe(503);
    expect((await processor.createCharge('k2', body())).status).toBe(200);
  });

  it('can apply a set number of times, or forever with times: null', async () => {
    const { processor } = setup();
    processor.addRule({ match: {}, fault: 'gateway_error', times: 2 });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await processor.createCharge(`a${i}`, body())).status);
    expect(codes).toEqual([503, 503, 200, 200]);

    processor.clearRules();
    processor.addRule({ match: {}, fault: 'gateway_error', times: null });
    for (let i = 0; i < 5; i++) expect((await processor.createCharge(`b${i}`, body())).status).toBe(503);
  });

  it('match on reference, source or idempotency key, and leave everything else alone', async () => {
    const { processor } = setup();
    processor.addRule({ match: { reference: 'ord_target' }, fault: 'gateway_error', times: null });
    processor.addRule({ match: { source: 'tok_special' }, fault: 'gateway_error', times: null });
    processor.addRule({ match: { idempotencyKey: 'key-target' }, fault: 'gateway_error', times: null });

    expect((await processor.createCharge('x1', { amount: 1, currency: 'NGN', metadata: { reference: 'ord_target' } })).status).toBe(503);
    expect((await processor.createCharge('x2', { amount: 1, currency: 'NGN', source: 'tok_special' })).status).toBe(503);
    expect((await processor.createCharge('key-target', { amount: 1, currency: 'NGN' })).status).toBe(503);
    expect((await processor.createCharge('x4', { amount: 1, currency: 'NGN', metadata: { reference: 'ord_other' } })).status).toBe(200);
  });

  it('the first live matching rule wins, and an exhausted rule is skipped', async () => {
    const { processor } = setup();
    processor.addRule({ match: {}, fault: 'gateway_error', times: 1 });
    processor.addRule({ match: {}, outcome: 'decline', times: 1 });

    expect((await processor.createCharge('k1', body())).status).toBe(503); // rule 1
    expect((await processor.createCharge('k2', body())).status).toBe(402); // rule 1 spent, rule 2
    expect((await processor.createCharge('k3', body())).status).toBe(200); // both spent
  });

  it('reports how often each has been used, and can be cleared', async () => {
    const { processor } = setup();
    processor.addRule({ match: {}, responseDelayMs: 1, times: null });
    await processor.createCharge('k1', body());
    await processor.createCharge('k2', body());
    expect(processor.listRules()[0].used).toBe(2);
    processor.clearRules();
    expect(processor.listRules()).toEqual([]);
  });

  it('a rule carries a response delay for the HTTP layer to apply', async () => {
    const { processor } = setup();
    processor.addRule({ match: {}, responseDelayMs: 750 });
    const exchange = await processor.createCharge('k', body());
    expect(exchange).toMatchObject({ status: 200, responseDelayMs: 750 });
  });
});

describe('fake processor: transport faults (4.2, Module 2.2)', () => {
  it('gateway_error: 503, no charge, and no idempotency record, so the retry is processed normally', async () => {
    const { processor } = setup();
    processor.addRule({ match: {}, fault: 'gateway_error' });
    const payload = body();

    const failed = await processor.createCharge('k', payload);
    expect(failed.status).toBe(503);
    expect(processor.stats()).toMatchObject({ charges: 0, idempotencyKeys: 0 });

    const retry = await processor.createCharge('k', payload);
    expect(retry.status).toBe(200);
    expect(retry.headers['Idempotent-Replayed']).toBeUndefined();
    expect(processor.stats().charges).toBe(1);
  });

  it('drop_before: the connection is killed, no charge exists, and the retry creates it', async () => {
    const { processor } = setup();
    processor.addRule({ match: {}, fault: 'drop_before' });
    const payload = body();

    expect((await processor.createCharge('k', payload)).action).toBe('drop');
    expect(processor.stats().charges).toBe(0);
    expect((await processor.createCharge('k', payload)).status).toBe(200);
  });

  it.each([
    ['error_after', 'respond', 500],
    ['drop_after', 'drop', 0],
  ] as const)(
    '%s: the money moved but the caller was not told; a retry with the same key gets the success back',
    async (fault, action, status) => {
      const { processor } = setup();
      processor.addRule({ match: {}, fault });
      const payload = body();

      const lost = await processor.createCharge('k', payload);
      expect(lost).toMatchObject({ action, status });
      expect(processor.stats().charges).toBe(1); // the charge exists

      const retry = await processor.createCharge('k', payload);
      expect(retry.status).toBe(200);
      expect(retry.headers['Idempotent-Replayed']).toBe('true');
      expect(bodyOf(retry).id).toBe(processor.listCharges()[0].id);
      expect(processor.stats().charges).toBe(1); // still exactly one
    },
  );

  it('the same lost response WITHOUT a stable key would double charge (the problem this system solves)', async () => {
    const { processor } = setup();
    processor.addRule({ match: {}, fault: 'drop_after' });
    const payload = body();

    await processor.createCharge('attempt-key-1', payload); // response lost
    await processor.createCharge('attempt-key-2', payload); // naive retry with a fresh key
    expect(processor.stats().charges).toBe(2);
  });

  it('a fault can also hit a replay: the stored charge is unaffected', async () => {
    const { processor } = setup();
    const payload = body();
    await processor.createCharge('k', payload);

    processor.addRule({ match: {}, fault: 'error_after' });
    expect((await processor.createCharge('k', payload)).status).toBe(500);
    expect(processor.stats().charges).toBe(1);
  });
});

describe('fake processor: asynchronous charges and resolve (4.2)', () => {
  it.each(['tok_pending', 'tok_requires_action'])('%s can be settled later as succeeded or failed', async (source) => {
    const { processor } = setup();
    const made = bodyOf(await processor.createCharge(`k-${source}`, body({ source })));

    const ok = processor.resolveCharge(made.id, 'succeeded');
    expect(ok).toMatchObject({ result: 'resolved', charge: { status: 'succeeded', failure_code: null } });

    const { processor: p2 } = setup();
    const made2 = bodyOf(await p2.createCharge(`k-${source}`, body({ source })));
    expect(p2.resolveCharge(made2.id, 'failed', 'authentication_failed')).toMatchObject({
      result: 'resolved',
      charge: { status: 'failed', failure_code: 'authentication_failed' },
    });
  });

  it('a settled charge cannot be settled again, and an unknown one is not found', async () => {
    const { processor } = setup();
    const made = bodyOf(await processor.createCharge('k', body({ source: 'tok_pending' })));
    processor.resolveCharge(made.id, 'succeeded');

    expect(processor.resolveCharge(made.id, 'failed')).toEqual({ result: 'not_resolvable', status: 'succeeded' });
    expect(processor.resolveCharge('ch_nope', 'succeeded')).toEqual({ result: 'not_found' });
  });

  it('a plain succeeded charge cannot be "resolved" either', async () => {
    const { processor } = setup();
    const made = bodyOf(await processor.createCharge('k', body()));
    expect(processor.resolveCharge(made.id, 'failed')).toMatchObject({ result: 'not_resolvable' });
  });

  it('the replay of the original request keeps the ORIGINAL snapshot; only a fresh read shows the truth', async () => {
    const { processor } = setup();
    const payload = body({ source: 'tok_pending' });
    const made = bodyOf(await processor.createCharge('k', payload));
    processor.resolveCharge(made.id, 'succeeded');

    const replay = await processor.createCharge('k', payload);
    expect(bodyOf(replay).status).toBe('pending'); // stale snapshot, by design
    expect(processor.getCharge(made.id)!.status).toBe('succeeded'); // the truth
  });
});

describe('fake processor: webhooks are emitted at the right moments', () => {
  it.each([
    ['succeeded charge', 'tok_visa', ['charge.succeeded']],
    ['declined charge', 'tok_declined', ['charge.failed']],
    ['pending charge (nothing yet)', 'tok_pending', []],
    ['requires_action charge (nothing yet)', 'tok_requires_action', []],
  ])('a %s emits %j', async (_name, source, expected) => {
    const { processor, webhooks } = setup();
    await processor.createCharge('k', body({ source }));
    expect(webhooks.listEvents().map((e) => e.type)).toEqual(expected);
  });

  it('settling a pending charge emits the matching event, carrying the charge as it is now', async () => {
    const { processor, webhooks } = setup();
    const made = bodyOf(await processor.createCharge('k', body({ source: 'tok_pending' })));
    processor.resolveCharge(made.id, 'failed', 'do_not_honor');

    const [event] = webhooks.listEvents();
    expect(event.type).toBe('charge.failed');
    expect(JSON.parse(event.body).data.object).toMatchObject({ id: made.id, status: 'failed', failure_code: 'do_not_honor' });
  });

  it('a replay does not emit a second event', async () => {
    const { processor, webhooks } = setup();
    const payload = body();
    await processor.createCharge('k', payload);
    await processor.createCharge('k', payload);
    expect(webhooks.listEvents()).toHaveLength(1);
  });
});

describe('fake processor: reset', () => {
  it('forgets charges, keys, rules, events and clock changes', async () => {
    const { processor, webhooks } = setup();
    processor.addRule({ match: {}, responseDelayMs: 1, times: null });
    await processor.createCharge('k', body());
    processor.advanceClock(1_000_000);

    processor.reset();

    expect(processor.stats()).toMatchObject({ charges: 0, idempotencyKeys: 0 });
    expect(processor.listRules()).toEqual([]);
    expect(webhooks.listEvents()).toEqual([]);
    expect(Math.abs(processor.now() - Date.now())).toBeLessThan(50);
  });
});

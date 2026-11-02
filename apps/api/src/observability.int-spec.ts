import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'kysely';
import { createDb, DB } from '@app/db';
import { WEBHOOK_SIGNATURE_HEADER } from '@app/payments-core';
import { JsonLogger } from '@app/observability';
import { createMerchant, createTestApiKey, startMigratedPostgres, TestPostgres, uid } from '@app/testing';
import { FakeProcessorModule } from '../../fake-processor/src/fake-processor.module';
import { ApiModule } from './api.module';
import { NEST_APP_OPTIONS } from './bootstrap';
import { METRICS_OPTIONS } from './metrics.controller';
import { PAYMENT_FLOW_OPTIONS } from './payments.service';
import { PROCESSOR_CLIENT_OPTIONS } from './processor.client';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Stage 10 on the API: request ids, metrics by route pattern, business counters, readiness, and what the logs hold. */
describe('API observability (API + Postgres + fake processor)', () => {
  let pg: TestPostgres;
  let processorApp: NestExpressApplication;
  let processorBase: string;
  let api: NestExpressApplication;
  let base: string;
  let merchantId: number;
  let apiKey: string;
  const extraApps: NestExpressApplication[] = [];

  async function startApi(overrides: { token?: string; db?: any } = {}) {
    const builder = Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(DB)
      .useValue(overrides.db ?? createDb(pg.connectionString, { maxConnections: 5 }))
      .overrideProvider(PROCESSOR_CLIENT_OPTIONS)
      .useValue({ baseUrl: processorBase, timeoutMs: 300 })
      .overrideProvider(PAYMENT_FLOW_OPTIONS)
      .useValue({ callRetries: 0, retryDelayMs: 1, retryMaxDelayMs: 1, feeBps: 150 })
      .overrideProvider(METRICS_OPTIONS)
      .useValue({ token: overrides.token });
    const app = (await builder.compile()).createNestApplication<NestExpressApplication>({ logger: false, ...NEST_APP_OPTIONS });
    await app.listen(0, '127.0.0.1');
    return { app, url: (await app.getUrl()).replace('[::1]', '127.0.0.1') };
  }

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    const processorModule = await Test.createTestingModule({ imports: [FakeProcessorModule] }).compile();
    processorApp = processorModule.createNestApplication<NestExpressApplication>({ logger: false });
    await processorApp.listen(0, '127.0.0.1');
    processorBase = (await processorApp.getUrl()).replace('[::1]', '127.0.0.1');
    const started = await startApi();
    api = started.app;
    base = started.url;
    merchantId = await createMerchant(pg.db);
    apiKey = await createTestApiKey(pg.db, merchantId);
  });

  afterAll(async () => {
    for (const app of extraApps) await app.close();
    await api?.close();
    await processorApp?.close();
    await pg?.stop();
  });

  const order = (over: Record<string, unknown> = {}) => ({ order_id: `ord_${uid()}`, amount: 5000, currency: 'NGN', source: 'tok_visa', ...over });
  const pay = (body: unknown, key = `key-${uid()}`, headers: Record<string, string> = {}) =>
    fetch(`${base}/v1/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key, authorization: `Bearer ${apiKey}`, ...headers },
      body: JSON.stringify(body),
    });

  /** The value of one sample line, or 0 if the series does not exist yet. */
  async function sample(series: string, url = base): Promise<number> {
    const text = await (await fetch(`${url}/metrics`)).text();
    const line = text.split('\n').find((l) => l.startsWith(`${series} `));
    return line ? Number(line.split(' ')[1]) : 0;
  }

  describe('request ids', () => {
    it('generates one, echoes it, and keeps a sane id the caller sent', async () => {
      const generated = await fetch(`${base}/health`);
      expect(generated.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);

      const kept = await fetch(`${base}/health`, { headers: { 'x-request-id': 'checkout-7f3a' } });
      expect(kept.headers.get('x-request-id')).toBe('checkout-7f3a');
    });

    it('replaces a hostile id instead of putting it in the logs', async () => {
      const res = await fetch(`${base}/health`, { headers: { 'x-request-id': 'x'.repeat(500) } });
      expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('is on the log lines written while that request is handled, and no secret is', async () => {
      const lines: Record<string, unknown>[] = [];
      Logger.overrideLogger(new JsonLogger({ write: (l) => lines.push(JSON.parse(l)) }));
      try {
        await fetch(`${base}/webhooks/processor`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [WEBHOOK_SIGNATURE_HEADER]: 't=1,v1=0123456789abcdef0123456789abcdef', 'x-request-id': 'trace-me-1' },
          body: '{}',
        });
      } finally {
        Logger.overrideLogger(false);
      }
      const rejected = lines.find((l) => String(l.message).includes('webhook rejected'));
      expect(rejected).toMatchObject({ level: 'warn', requestId: 'trace-me-1', context: 'WebhooksService' });
      expect(JSON.stringify(lines)).not.toContain('0123456789abcdef0123456789abcdef');
    });
  });

  describe('metrics', () => {
    it('counts requests by route PATTERN, so ids in the url never become labels', async () => {
      const before = await sample('http_requests_total{method="GET",route="/v1/payments/:id",status_class="4xx"}');
      for (let i = 0; i < 3; i++) {
        await fetch(`${base}/v1/payments/pay_${uid()}`, { headers: { authorization: `Bearer ${apiKey}` } });
      }
      expect(await sample('http_requests_total{method="GET",route="/v1/payments/:id",status_class="4xx"}')).toBe(before + 3);
      const text = await (await fetch(`${base}/metrics`)).text();
      expect(text).not.toMatch(/route="[^"]*pay_[0-9a-f]+/);
    });

    it('collapses unknown paths into one label, so a scanner cannot create series', async () => {
      const before = await sample('http_requests_total{method="GET",route="unmatched",status_class="4xx"}');
      for (let i = 0; i < 5; i++) await fetch(`${base}/wp-admin/${uid()}`);
      expect(await sample('http_requests_total{method="GET",route="unmatched",status_class="4xx"}')).toBe(before + 5);
    });

    it('records the payment flow: a claim, a processor call, an outcome, then a replay', async () => {
      const claimed = await sample('idempotency_claims_total{result="claimed"}');
      const replay = await sample('idempotency_claims_total{result="replay"}');
      const succeeded = await sample('payment_outcomes_total{result="succeeded"}');
      const calls = await sample('processor_calls_total{result="succeeded"}');
      const durations = await sample('processor_call_duration_seconds_count');

      const key = `key-${uid()}`;
      const body = order();
      expect((await pay(body, key)).status).toBe(201);
      expect((await pay(body, key)).status).toBe(201);

      expect(await sample('idempotency_claims_total{result="claimed"}')).toBe(claimed + 1);
      expect(await sample('idempotency_claims_total{result="replay"}')).toBe(replay + 1);
      expect(await sample('payment_outcomes_total{result="succeeded"}')).toBe(succeeded + 1);
      expect(await sample('processor_calls_total{result="succeeded"}')).toBe(calls + 1); // the replay did not call the processor
      expect(await sample('processor_call_duration_seconds_count')).toBe(durations + 1);
    });

    it('counts a decline, a mismatch and an unknown outcome apart', async () => {
      const declined = await sample('payment_outcomes_total{result="declined"}');
      const mismatch = await sample('idempotency_claims_total{result="mismatch"}');
      const unknown = await sample('processor_calls_total{result="unknown"}');

      expect((await pay(order({ source: 'tok_declined' }))).status).toBe(402);
      const key = `key-${uid()}`;
      await pay(order(), key);
      expect((await pay(order(), key)).status).toBe(422);

      await fetch(`${processorBase}/_control/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fault: 'gateway_error', times: 1 }) });
      expect((await pay(order())).status).toBe(202); // unknown: stays calling_processor for recovery

      expect(await sample('payment_outcomes_total{result="declined"}')).toBe(declined + 1);
      expect(await sample('idempotency_claims_total{result="mismatch"}')).toBe(mismatch + 1);
      expect(await sample('processor_calls_total{result="unknown"}')).toBe(unknown + 1);
    });

    it('counts authentication by outcome, and a rejected key is logged by prefix only', async () => {
      const ok = await sample('auth_attempts_total{result="ok"}');
      const missing = await sample('auth_attempts_total{result="missing"}');
      const invalid = await sample('auth_attempts_total{result="invalid"}');
      const lines: Record<string, unknown>[] = [];
      Logger.overrideLogger(new JsonLogger({ write: (l) => lines.push(JSON.parse(l)) }));
      const badKey = `pk_${'1'.repeat(12)}_${'S'.repeat(43)}`;
      try {
        await fetch(`${base}/v1/balance`, { headers: { authorization: `Bearer ${apiKey}` } });
        await fetch(`${base}/v1/balance`);
        await fetch(`${base}/v1/balance`, { headers: { authorization: `Bearer ${badKey}` } });
      } finally {
        Logger.overrideLogger(false);
      }
      expect(await sample('auth_attempts_total{result="ok"}')).toBe(ok + 1);
      expect(await sample('auth_attempts_total{result="missing"}')).toBe(missing + 1);
      expect(await sample('auth_attempts_total{result="invalid"}')).toBe(invalid + 1);
      const rejection = lines.find((l) => String(l.message).includes('api key rejected'));
      expect(rejection?.message).toContain('unknown');
      expect(rejection?.message).toContain('1'.repeat(12));
      expect(JSON.stringify(lines)).not.toContain('S'.repeat(43)); // the secret part of a presented key never reaches a log
    });

    it('counts webhooks that fail their signature', async () => {
      const before = await sample('webhook_events_total{result="rejected_signature"}');
      await fetch(`${base}/webhooks/processor`, { method: 'POST', headers: { 'content-type': 'application/json', [WEBHOOK_SIGNATURE_HEADER]: 't=1,v1=00' }, body: '{}' });
      expect(await sample('webhook_events_total{result="rejected_signature"}')).toBe(before + 1);
    });

    it('serves the standard prometheus content type and process metrics', async () => {
      const res = await fetch(`${base}/metrics`);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(await res.text()).toContain('process_cpu_user_seconds_total');
    });
  });

  describe('response headers', () => {
    it('carry no framework banner, forbid sniffing and caching', async () => {
      const res = await fetch(`${base}/v1/balance`, { headers: { authorization: `Bearer ${apiKey}` } });
      expect(res.headers.get('x-powered-by')).toBeNull();
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const missing = await fetch(`${base}/no/such/path`);
      expect(missing.headers.get('x-powered-by')).toBeNull();
      expect(missing.headers.get('cache-control')).toBe('no-store');
    });
  });

  describe('/metrics access', () => {
    it('needs the bearer token when one is configured, and only then', async () => {
      const { app, url } = await startApi({ token: 'metrics-token-0123456789' });
      extraApps.push(app);
      expect((await fetch(`${url}/metrics`)).status).toBe(401);
      expect((await fetch(`${url}/metrics`, { headers: { authorization: 'Bearer wrong-token-0123456789' } })).status).toBe(401);
      expect((await fetch(`${url}/metrics`, { headers: { authorization: 'Bearer metrics-token-0123456789' } })).status).toBe(200);
      expect((await fetch(`${url}/health`)).status).toBe(200); // probes never need it
    });
  });

  describe('health', () => {
    it('is ready when the database answers', async () => {
      const res = await fetch(`${base}/health/ready`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ready' });
    });

    it('is NOT ready when the database is gone, says which check failed, and stays alive', async () => {
      const dead = createDb(pg.connectionString, { maxConnections: 1 });
      await sql`select 1`.execute(dead); // Kysely only creates its pool on first use; destroying an unused one does nothing
      await dead.destroy();
      const { app, url } = await startApi({ db: dead });
      extraApps.push(app);

      const ready = await fetch(`${url}/health/ready`);
      expect(ready.status).toBe(503);
      const body = await ready.json();
      expect(body).toEqual({ status: 'unavailable', failed: ['database'] });
      expect(JSON.stringify(body)).not.toMatch(/postgres|pool|ECONN|localhost/i);
      expect((await fetch(`${url}/health`)).status).toBe(200); // liveness does not depend on the database
    });
  });
});

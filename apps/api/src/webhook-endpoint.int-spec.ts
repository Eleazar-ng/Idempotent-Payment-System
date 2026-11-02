import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createDb, DB } from '@app/db';
import { createMerchant, createTestApiKey, startMigratedPostgres, TestPostgres } from '@app/testing';
import { ApiModule } from './api.module';
import { NEST_APP_OPTIONS } from './bootstrap';
import { WEBHOOK_URL_OPTIONS } from './webhook-endpoint.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A merchant manages its own webhook endpoint (Stage 11), under the strict destination policy and a fake DNS. */
describe('webhook endpoint management (API + Postgres)', () => {
  let pg: TestPostgres;
  let app: NestExpressApplication;
  let base: string;
  let merchantId: number;
  let auth: { authorization: string };
  let dns: Record<string, string[] | 'fail'> = {};

  beforeAll(async () => {
    pg = await startMigratedPostgres();
    const mod = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideProvider(DB)
      .useValue(createDb(pg.connectionString, { maxConnections: 5 }))
      .overrideProvider(WEBHOOK_URL_OPTIONS)
      .useValue({
        policy: { allowHttp: false, allowPrivateNetworks: false },
        resolver: async (host: string) => {
          const answer = dns[host];
          if (answer === 'fail' || answer === undefined) throw new Error(`ENOTFOUND ${host}`);
          return answer;
        },
      })
      .compile();
    app = mod.createNestApplication<NestExpressApplication>({ logger: false, ...NEST_APP_OPTIONS });
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    merchantId = await createMerchant(pg.db);
    auth = { authorization: `Bearer ${await createTestApiKey(pg.db, merchantId)}` };
    dns = { 'hooks.merchant.example.com': ['93.184.216.34'], 'other.merchant.example.com': ['93.184.216.35'] };
  });

  const call = async (method: string, path = '', body?: unknown, headers: Record<string, string> = auth) => {
    const res = await fetch(`${base}/v1/webhook-endpoint${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as any) : undefined };
  };
  const stored = () => pg.db.selectFrom('merchants').select(['webhook_url', 'webhook_secret']).where('id', '=', merchantId).executeTakeFirstOrThrow();

  it('registers an endpoint: 201 with the URL and a signing secret, shown once', async () => {
    const res = await call('PUT', '', { url: 'https://hooks.merchant.example.com/payments' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ object: 'webhook_endpoint', url: 'https://hooks.merchant.example.com/payments' });
    expect(res.body.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(await stored()).toEqual({ webhook_url: 'https://hooks.merchant.example.com/payments', webhook_secret: res.body.secret });
  });

  it('never shows the secret again: reading returns the URL only', async () => {
    const created = await call('PUT', '', { url: 'https://hooks.merchant.example.com/payments' });
    const read = await call('GET');
    expect(read).toEqual({ status: 200, body: { object: 'webhook_endpoint', url: 'https://hooks.merchant.example.com/payments' } });
    expect(JSON.stringify(read)).not.toContain(created.body.secret);
  });

  it('changing the URL keeps the secret, so the merchant\'s verifier keeps working: 200, no secret in the answer', async () => {
    const created = await call('PUT', '', { url: 'https://hooks.merchant.example.com/payments' });
    const changed = await call('PUT', '', { url: 'https://other.merchant.example.com/events' });
    expect(changed.status).toBe(200);
    expect(changed.body.secret).toBeUndefined();
    expect(await stored()).toEqual({ webhook_url: 'https://other.merchant.example.com/events', webhook_secret: created.body.secret });
  });

  it('rotating makes a new secret, shown once, and the old one is gone', async () => {
    const created = await call('PUT', '', { url: 'https://hooks.merchant.example.com/payments' });
    const rotated = await call('POST', '/secret');
    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(created.body.secret);
    expect((await stored()).webhook_secret).toBe(rotated.body.secret);
  });

  it('rotating or reading with no endpoint is a 404', async () => {
    expect((await call('GET')).status).toBe(404);
    expect((await call('POST', '/secret')).status).toBe(404);
    expect((await call('GET')).body.error.code).toBe('webhook_endpoint_not_configured');
  });

  it('removing clears both, is idempotent, and later events are skipped (nothing to deliver to)', async () => {
    await call('PUT', '', { url: 'https://hooks.merchant.example.com/payments' });
    expect((await call('DELETE')).status).toBe(204);
    expect((await call('DELETE')).status).toBe(204);
    expect(await stored()).toEqual({ webhook_url: null, webhook_secret: null });
    expect((await call('GET')).status).toBe(404);
  });

  describe('what it refuses (422), and stores nothing', () => {
    it.each([
      ['plain http', 'http://hooks.merchant.example.com/p', 'scheme_not_allowed'],
      ['an internal address', 'https://10.0.0.5/hook', 'forbidden_address'],
      ['the cloud metadata address', 'https://169.254.169.254/latest/meta-data/', 'forbidden_address'],
      ['localhost', 'https://localhost/hook', 'forbidden_host'],
      ['an address spelled as a number', 'https://2130706433/hook', 'forbidden_address'],
      ['an IPv6 loopback', 'https://[::1]/hook', 'forbidden_address'],
      ['credentials in the URL', 'https://user:pw@hooks.merchant.example.com/p', 'credentials_in_url'],
      ['a low port', 'https://hooks.merchant.example.com:22/p', 'port_not_allowed'],
      ['a file URL', 'file:///etc/passwd', 'scheme_not_allowed'],
      ['gibberish', 'not a url', 'invalid_url'],
    ])('%s', async (_name, url, reason) => {
      const res = await call('PUT', '', { url });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('invalid_webhook_url');
      expect(res.body.reason).toBe(reason);
      expect(await stored()).toEqual({ webhook_url: null, webhook_secret: null });
    });

    it('a name that resolves to a private address', async () => {
      dns['evil.example.com'] = ['192.168.1.10'];
      const res = await call('PUT', '', { url: 'https://evil.example.com/hook' });
      expect(res).toMatchObject({ status: 422, body: { error: { code: 'invalid_webhook_url' }, reason: 'forbidden_address' } });
      expect((await stored()).webhook_url).toBeNull();
    });

    it('a name whose answers mix public and private addresses', async () => {
      dns['mixed.example.com'] = ['93.184.216.34', '10.0.0.5'];
      expect((await call('PUT', '', { url: 'https://mixed.example.com/hook' })).status).toBe(422);
    });

    it('a name that does not resolve', async () => {
      const res = await call('PUT', '', { url: 'https://nowhere.example.com/hook' });
      expect(res).toMatchObject({ status: 422, body: { error: { code: 'webhook_host_unresolvable' } } });
    });

    it('a bad body: 400, and unknown fields are refused rather than ignored', async () => {
      expect((await call('PUT', '', {})).status).toBe(400);
      expect((await call('PUT', '', { url: 5 })).status).toBe(400);
      expect((await call('PUT', '', { url: 'https://hooks.merchant.example.com/p', secret: 'mine' })).status).toBe(400);
    });

    it('a rejected change leaves the existing endpoint exactly as it was', async () => {
      const created = await call('PUT', '', { url: 'https://hooks.merchant.example.com/payments' });
      await call('PUT', '', { url: 'https://10.0.0.5/hook' });
      expect(await stored()).toEqual({ webhook_url: 'https://hooks.merchant.example.com/payments', webhook_secret: created.body.secret });
    });
  });

  describe('who may call it', () => {
    it.each([
      ['GET', ''],
      ['PUT', ''],
      ['POST', '/secret'],
      ['DELETE', ''],
    ])('%s %s needs a valid API key', async (method, path) => {
      expect((await call(method, path, method === 'PUT' ? { url: 'https://hooks.merchant.example.com/p' } : undefined, {})).status).toBe(401);
      expect((await call(method, path, method === 'PUT' ? { url: 'https://hooks.merchant.example.com/p' } : undefined, { authorization: `Bearer pk_${'0'.repeat(12)}_${'A'.repeat(43)}` })).status).toBe(401);
    });

    it('a merchant can only touch its own endpoint', async () => {
      await call('PUT', '', { url: 'https://hooks.merchant.example.com/payments' });
      const otherMerchant = await createMerchant(pg.db);
      const otherAuth = { authorization: `Bearer ${await createTestApiKey(pg.db, otherMerchant)}` };
      expect((await call('GET', '', undefined, otherAuth)).status).toBe(404);
      await call('DELETE', '', undefined, otherAuth);
      expect((await call('GET')).status).toBe(200); // ours is untouched
    });
  });

  it('two first registrations at once: exactly one is told it created the secret, and they agree on it', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => call('PUT', '', { url: 'https://hooks.merchant.example.com/payments' })));
    const created = results.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect((await stored()).webhook_secret).toBe(created[0].body.secret);
  });
});

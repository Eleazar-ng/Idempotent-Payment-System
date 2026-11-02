import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSafeFetch, resolveAllowedAddress } from './safe-fetch';
import { STRICT_URL_POLICY, UnsafeUrlError } from './url-policy';

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: string;
}

describe('safe fetch (real local servers)', () => {
  let server: Server;
  let port: number;
  let seen: Seen[] = [];
  let respond: (req: Seen, res: import('node:http').ServerResponse) => void = (_r, res) => res.writeHead(200).end('ok');
  const DEV = { allowHttp: true, allowPrivateNetworks: true };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
        seen.push(record);
        respond(record, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen = [];
    respond = (_r, res) => res.writeHead(200).end('ok');
  });

  describe('what it refuses, before any connection is made', () => {
    it.each([
      ['http://127.0.0.1:{port}/hook', 'scheme_not_allowed'],
      ['https://127.0.0.1:{port}/hook', 'forbidden_address'],
      ['https://localhost:{port}/hook', 'forbidden_host'],
      ['https://[::1]:{port}/hook', 'forbidden_address'],
      ['https://169.254.169.254:{port}/latest/meta-data/', 'forbidden_address'],
      ['https://2130706433:{port}/hook', 'forbidden_address'],
    ])('%s under the strict policy (%s)', async (template, reason) => {
      const url = template.replace('{port}', String(port)); // the port exists only once the server is listening
      const safe = createSafeFetch({ policy: STRICT_URL_POLICY, resolver: async () => ['127.0.0.1'] });
      await expect(safe(url, { method: 'POST', body: '{}' })).rejects.toMatchObject({ name: 'UnsafeUrlError', reason });
      expect(seen).toEqual([]);
    });

    it('a name that resolves to an internal address', async () => {
      const safe = createSafeFetch({ policy: STRICT_URL_POLICY, resolver: async () => ['10.0.0.5'] });
      await expect(safe(`https://merchant.example.com:${port}/hook`)).rejects.toMatchObject({ reason: 'forbidden_address' });
      expect(seen).toEqual([]);
    });

    it('a name whose answers MIX public and internal addresses (the rebinding trick)', async () => {
      const safe = createSafeFetch({ policy: STRICT_URL_POLICY, resolver: async () => ['93.184.216.34', '127.0.0.1'] });
      await expect(safe(`https://merchant.example.com:${port}/hook`)).rejects.toBeInstanceOf(UnsafeUrlError);
      expect(seen).toEqual([]);
    });

    it('a name that does not resolve to anything', async () => {
      const safe = createSafeFetch({ policy: STRICT_URL_POLICY, resolver: async () => [] });
      await expect(safe(`https://merchant.example.com:${port}/hook`)).rejects.toBeInstanceOf(UnsafeUrlError);
    });

    it('an unresolvable name is an ordinary network error, not a policy refusal: the caller may retry', async () => {
      const safe = createSafeFetch({
        policy: STRICT_URL_POLICY,
        resolver: async () => {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND merchant.example.com'), { code: 'ENOTFOUND' });
        },
      });
      const error = await safe(`https://merchant.example.com:${port}/hook`).catch((e: unknown) => e);
      expect((error as Error).message).toContain('ENOTFOUND'); // (node core errors come from another realm, so no instanceof Error)
      expect(error).not.toBeInstanceOf(UnsafeUrlError);
    });
  });

  describe('what it does when the destination is allowed', () => {
    it('sends the request to the CHECKED address, with the name in the Host header and the body intact', async () => {
      const safe = createSafeFetch({ policy: DEV, resolver: async () => ['127.0.0.1'] });
      const res = await safe(`http://merchant.test:${port}/hooks/pay?x=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-event-id': 'evt_1' },
        body: '{"a":"é"}',
      });
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ method: 'POST', url: '/hooks/pay?x=1', body: '{"a":"é"}' });
      expect(seen[0].headers.host).toBe(`merchant.test:${port}`);
      expect(seen[0].headers['x-event-id']).toBe('evt_1');
      expect(seen[0].headers['content-length']).toBe(String(Buffer.byteLength('{"a":"é"}')));
    });

    it('resolves the name afresh on EVERY request: an address that turns internal later is refused', async () => {
      const answers = [['127.0.0.1'], ['10.0.0.5']];
      let calls = 0;
      const safe = createSafeFetch({ policy: { allowHttp: true, allowPrivateNetworks: false }, resolver: async () => answers[calls++] });
      // first answer is loopback, which the strict-address policy refuses too, so use the dev-address policy for call one:
      const devSafe = createSafeFetch({ policy: DEV, resolver: async () => ['127.0.0.1'] });
      expect((await devSafe(`http://merchant.test:${port}/`)).status).toBe(200);

      await expect(safe(`http://merchant.test:${port}/`)).rejects.toBeInstanceOf(UnsafeUrlError); // 127.0.0.1 under a policy that forbids it
      await expect(safe(`http://merchant.test:${port}/`)).rejects.toBeInstanceOf(UnsafeUrlError); // 10.0.0.5
      expect(calls).toBe(2);
      expect(seen).toHaveLength(1);
    });

    it('asks the resolver exactly once per request: the HTTP client never resolves the name itself', async () => {
      let calls = 0;
      const safe = createSafeFetch({
        policy: DEV,
        resolver: async () => {
          calls++;
          return ['127.0.0.1'];
        },
      });
      await safe(`http://merchant.test:${port}/`);
      expect(calls).toBe(1);
    });

    it('does not follow a redirect: the 3xx comes back as it is, and the target is never requested', async () => {
      respond = (_r, res) => res.writeHead(302, { location: `http://127.0.0.1:${port}/elsewhere` }).end();
      const safe = createSafeFetch({ policy: DEV, resolver: async () => ['127.0.0.1'] });
      const res = await safe(`http://merchant.test:${port}/hook`, { method: 'POST', body: '{}' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('/elsewhere');
      expect(seen.map((s) => s.url)).toEqual(['/hook']);
    });

    it('returns as soon as the headers arrive, even if the body never ends', async () => {
      respond = (_r, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('start');
        // never ends
      };
      const safe = createSafeFetch({ policy: DEV, resolver: async () => ['127.0.0.1'] });
      const started = Date.now();
      const res = await safe(`http://merchant.test:${port}/`, { signal: AbortSignal.timeout(5000) });
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('passes the status and headers of error answers, so Retry-After can be read', async () => {
      respond = (_r, res) => res.writeHead(503, { 'retry-after': '7' }).end();
      const safe = createSafeFetch({ policy: DEV, resolver: async () => ['127.0.0.1'] });
      const res = await safe(`http://merchant.test:${port}/`);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('7');
    });

    it('gives up when told to, with a timeout error', async () => {
      respond = () => undefined; // never answers
      const safe = createSafeFetch({ policy: DEV, resolver: async () => ['127.0.0.1'] });
      const error = await safe(`http://merchant.test:${port}/`, { signal: AbortSignal.timeout(200) }).catch((e: unknown) => e);
      expect((error as Error).name).toMatch(/TimeoutError|AbortError/);
    });

    it('reports a refused connection as a plain network error', async () => {
      const closed = createServer();
      await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
      const freePort = (closed.address() as AddressInfo).port;
      await new Promise<void>((resolve) => closed.close(() => resolve()));
      const safe = createSafeFetch({ policy: DEV, resolver: async () => ['127.0.0.1'] });
      const error = await safe(`http://merchant.test:${freePort}/`).catch((e: unknown) => e);
      expect((error as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
      expect(error).not.toBeInstanceOf(UnsafeUrlError);
    });
  });

  describe('resolveAllowedAddress', () => {
    it('returns the first allowed address and its family', async () => {
      expect(await resolveAllowedAddress(new URL('https://m.example.com/'), STRICT_URL_POLICY, async () => ['93.184.216.34'])).toEqual({ address: '93.184.216.34', family: 4 });
      expect(await resolveAllowedAddress(new URL('https://m.example.com/'), STRICT_URL_POLICY, async () => ['2606:4700:4700::1111'])).toEqual({ address: '2606:4700:4700::1111', family: 6 });
    });
    it('does not ask DNS about an address literal', async () => {
      const resolver = jest.fn(async () => ['10.0.0.1']);
      expect((await resolveAllowedAddress(new URL('https://93.184.216.34/'), STRICT_URL_POLICY, resolver)).address).toBe('93.184.216.34');
      expect(resolver).not.toHaveBeenCalled();
    });
  });
});

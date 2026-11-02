import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { assertAddressesAllowed, checkWebhookUrl } from './url-policy';
import type { UrlPolicy } from './url-policy';

/** Turns a host name into the addresses it points at right now. Injected so tests control DNS. */
export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export interface SafeFetchOptions {
  policy: UrlPolicy;
  resolver?: Resolver;
}

const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, '');

/**
 * Resolves a URL's host and refuses unless EVERY address is allowed. Returns the address to connect to.
 * Used at registration (to tell the merchant early) and by `createSafeFetch` at every delivery.
 */
export async function resolveAllowedAddress(url: URL, policy: UrlPolicy, resolver: Resolver = systemResolver): Promise<{ address: string; family: 4 | 6 }> {
  const host = bare(url.hostname);
  const addresses = isIP(host) !== 0 ? [host] : await resolver(host);
  assertAddressesAllowed(addresses, policy);
  const address = addresses[0];
  return { address, family: isIP(address) === 6 ? 6 : 4 };
}

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * A `fetch` for sending webhooks to addresses merchants gave us. It differs from the real one on purpose:
 *
 *   - the URL is checked against the policy, the name is resolved HERE, every address must be allowed, and the connection is
 *     made to the address that was checked. The name is never resolved a second time by the HTTP client, so a DNS answer that
 *     changes between the check and the connect (DNS rebinding) cannot send the request somewhere else.
 *   - TLS still verifies the certificate against the host NAME (servername), not the address.
 *   - redirects are never followed: a 3xx comes back as a 3xx. A redirect would send a signed body somewhere nobody registered.
 *   - the response body is never read: we only need the status line and headers, and a slow or endless body must not hold a worker.
 *
 * Throws `UnsafeUrlError` for anything the policy refuses, before any connection is made. Other failures (refused connection, timeout,
 * unresolvable name) are ordinary network errors the caller retries.
 */
export function createSafeFetch(options: SafeFetchOptions): (url: string, init?: SafeFetchInit) => Promise<Response> {
  const resolver = options.resolver ?? systemResolver;
  return async (raw, init = {}) => {
    const url = checkWebhookUrl(raw, options.policy);
    const target = await resolveAllowedAddress(url, options.policy, resolver);
    const host = bare(url.hostname);
    const secure = url.protocol === 'https:';
    const body = init.body === undefined ? undefined : Buffer.from(init.body, 'utf8');

    return new Promise<Response>((resolve, reject) => {
      const request = (secure ? https : http).request(
        {
          hostname: host,
          port: url.port === '' ? undefined : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: init.method ?? 'GET',
          headers: { ...init.headers, host: url.host, ...(body ? { 'content-length': String(body.length) } : {}) },
          ...(secure && isIP(host) === 0 ? { servername: host } : {}),
          // The one place a name becomes an address: always the one we checked.
          lookup: (_name, lookupOptions, callback) => {
            if (lookupOptions && (lookupOptions as { all?: boolean }).all) {
              (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: target.address, family: target.family }]);
            } else {
              callback(null, target.address, target.family);
            }
          },
          signal: init.signal,
        },
        (response) => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
            else if (value !== undefined) headers.set(name, value);
          }
          const status = response.statusCode ?? 0;
          response.resume();
          request.destroy(); // headers are all we wanted
          if (status < 200 || status > 599) reject(new Error(`unusable status ${status}`));
          else resolve(new Response(null, { status, headers }));
        },
      );
      request.on('error', (error) => {
        // After we destroyed it ourselves the error is just the closed socket: the promise has already settled.
        reject(init.signal?.aborted ? (init.signal.reason ?? error) : error);
      });
      request.end(body);
    });
  };
}

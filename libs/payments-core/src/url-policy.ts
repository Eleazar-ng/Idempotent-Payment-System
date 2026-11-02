import { BlockList, isIP } from 'node:net';

/**
 * Where we are willing to send a merchant's webhooks (Module 5: server-side request forgery).
 *
 * The danger: a merchant registers `http://169.254.169.254/latest/meta-data/` (a cloud provider's credential service) or
 * `http://localhost:5432` and our server, which sits inside the network, makes the request for them. The rules here are
 * pure (no network); `safe-fetch` in the worker applies them again at delivery time against the address actually connected to.
 */
export interface UrlPolicy {
  /** Allow `http://`. For local development only: a signed body over plain http can be read and replayed on the way. */
  allowHttp: boolean;
  /** Allow loopback, private, link-local and other internal addresses. For local development only. */
  allowPrivateNetworks: boolean;
}

export const STRICT_URL_POLICY: UrlPolicy = { allowHttp: false, allowPrivateNetworks: false };

export type UnsafeUrlReason =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'credentials_in_url'
  | 'forbidden_host'
  | 'forbidden_address'
  | 'port_not_allowed'
  | 'url_too_long';

export class UnsafeUrlError extends Error {
  constructor(
    readonly reason: UnsafeUrlReason,
    message: string,
  ) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

const MAX_URL_LENGTH = 2048;

const V4 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT, also used by some cloud internals
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including the cloud metadata service 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and 255.255.255.255 broadcast
] as const) {
  V4.addSubnet(net, bits, 'ipv4');
}

const V6 = new BlockList();
for (const [net, bits] of [
  ['::', 96], // unspecified, loopback, and the deprecated IPv4-compatible range
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo tunnelling
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address we would have to trust)
  ['fc00::', 7], // unique local (private)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
] as const) {
  V6.addSubnet(net, bits, 'ipv6');
}

/** Expands an IPv6 text address to its 16 bytes. Assumes `isIP(text) === 6`. Handles `::` and a trailing dotted IPv4. */
function ipv6Bytes(text: string): number[] {
  let address = text.split('%')[0]; // drop a zone id (fe80::1%eth0)
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) {
    const quad = dotted[2].split('.').map(Number);
    address = `${dotted[1]}${((quad[0] << 8) | quad[1]).toString(16)}:${((quad[2] << 8) | quad[3]).toString(16)}`;
  }
  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups.flatMap((g) => {
    const n = parseInt(g || '0', 16);
    return [n >> 8, n & 0xff];
  });
}

/**
 * True if connecting to this literal address could reach something internal. Fails CLOSED: anything that is not a
 * well-formed IPv4 or IPv6 address counts as forbidden, so a parsing surprise can never become a hole.
 */
export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return V4.check(address, 'ipv4');
  if (family !== 6) return true;

  const bytes = ipv6Bytes(address);
  const embedded = (offset: number) => bytes.slice(offset, offset + 4).join('.');
  const zeros = (n: number) => bytes.slice(0, n).every((b) => b === 0);

  // ::ffff:a.b.c.d is an IPv4 address wearing an IPv6 coat: judge the IPv4 inside.
  if (zeros(10) && bytes[10] === 0xff && bytes[11] === 0xff) return V4.check(embedded(12), 'ipv4');
  // 64:ff9b::/96 translates to IPv4 too (NAT64): judge the IPv4 inside.
  if (bytes.slice(0, 12).join(',') === [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0].join(',')) return V4.check(embedded(12), 'ipv4');
  return V6.check(address.split('%')[0], 'ipv6');
}

const LOW_PORTS_ALLOWED = new Set([80, 443]);

/**
 * Parses and checks a URL a merchant gave us. Returns the normalised URL (what the WHATWG parser makes of it:
 * `http://2130706433/` becomes `http://127.0.0.1/` here, which is why the check runs on the parsed host, never the raw text).
 * Throws UnsafeUrlError. A hostname that is a name (not an address) passes here; whether it RESOLVES to something
 * internal is checked separately, at registration and again at every delivery.
 */
export function checkWebhookUrl(raw: string, policy: UrlPolicy = STRICT_URL_POLICY): URL {
  if (typeof raw !== 'string' || raw.length === 0) throw new UnsafeUrlError('invalid_url', 'The URL is empty.');
  if (raw.length > MAX_URL_LENGTH) throw new UnsafeUrlError('url_too_long', `The URL is longer than ${MAX_URL_LENGTH} characters.`);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('invalid_url', 'The URL could not be parsed.');
  }

  if (url.protocol !== 'https:' && !(policy.allowHttp && url.protocol === 'http:')) {
    throw new UnsafeUrlError('scheme_not_allowed', policy.allowHttp ? 'Only http and https URLs are allowed.' : 'Only https URLs are allowed.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new UnsafeUrlError('credentials_in_url', 'The URL must not contain a username or password.');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!policy.allowPrivateNetworks) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) {
      throw new UnsafeUrlError('forbidden_host', 'That host name refers to an internal network.');
    }
    if (isIP(host) !== 0 && isForbiddenAddress(host)) {
      throw new UnsafeUrlError('forbidden_address', 'That address is on an internal or reserved network.');
    }
    if (host.length === 0) throw new UnsafeUrlError('invalid_url', 'The URL has no host.');
    const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
    if (port < 1024 && !LOW_PORTS_ALLOWED.has(port)) {
      throw new UnsafeUrlError('port_not_allowed', 'Ports below 1024 other than 80 and 443 are not allowed.');
    }
  }
  return url;
}

/** Checks every address a name resolved to. ONE internal address among public ones is enough to refuse (the rebinding trick). */
export function assertAddressesAllowed(addresses: readonly string[], policy: UrlPolicy): void {
  if (addresses.length === 0) throw new UnsafeUrlError('forbidden_host', 'The host name did not resolve to any address.');
  if (policy.allowPrivateNetworks) return;
  for (const address of addresses) {
    if (isForbiddenAddress(address)) throw new UnsafeUrlError('forbidden_address', 'The host name resolves to an internal or reserved address.');
  }
}

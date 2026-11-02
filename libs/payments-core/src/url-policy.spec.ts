import { assertAddressesAllowed, checkWebhookUrl, isForbiddenAddress, STRICT_URL_POLICY, UnsafeUrlError } from './url-policy';
import type { UnsafeUrlReason, UrlPolicy } from './url-policy';

const reasonOf = (raw: string, policy: UrlPolicy = STRICT_URL_POLICY): UnsafeUrlReason | undefined => {
  try {
    checkWebhookUrl(raw, policy);
    return undefined;
  } catch (e) {
    if (e instanceof UnsafeUrlError) return e.reason;
    throw e;
  }
};

describe('isForbiddenAddress', () => {
  it.each([
    // loopback, private, link-local (the metadata service), CGNAT, this-network, reserved, multicast, broadcast
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3', '192.0.0.8', '192.0.2.5',
    '198.18.0.1', '198.19.255.255', '198.51.100.9', '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    // IPv6: loopback, unspecified, unique local, link-local, multicast, documentation, Teredo, 6to4
    '::1', '::', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'febf::1', 'ff02::1', '2001:db8::1', '2001::1', '2002:7f00:1::', '100::1',
    // IPv4 inside IPv6, in every spelling
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe',
    '0:0:0:0:0:ffff:127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '::127.0.0.1', '::1%lo',
    // not an address at all: fail closed
    '', 'localhost', 'example.com', '1.2.3', '256.1.1.1', '1.2.3.4.5', '::g',
  ])('%p is forbidden', (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.1.1', '192.169.0.1',
    '11.0.0.1', '126.255.255.255', '128.0.0.1', '223.255.255.255',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2a00:1450:4001::1',
  ])('%p is public', (address) => {
    expect(isForbiddenAddress(address)).toBe(false);
  });
});

describe('checkWebhookUrl', () => {
  it('accepts an ordinary https url, and returns the parsed form', () => {
    expect(checkWebhookUrl('https://merchant.example.com/hooks/payments?x=1').href).toBe('https://merchant.example.com/hooks/payments?x=1');
    expect(reasonOf('https://merchant.example.com:8443/hook')).toBeUndefined();
    expect(reasonOf('https://93.184.216.34/hook')).toBeUndefined();
    expect(reasonOf('https://[2606:4700:4700::1111]/hook')).toBeUndefined();
  });

  it.each([
    ['http://merchant.example.com/hook', 'scheme_not_allowed'],
    ['ftp://merchant.example.com/hook', 'scheme_not_allowed'],
    ['file:///etc/passwd', 'scheme_not_allowed'],
    ['gopher://merchant.example.com/', 'scheme_not_allowed'],
    ['javascript:alert(1)', 'scheme_not_allowed'],
    ['https://user:pass@merchant.example.com/', 'credentials_in_url'],
    ['https://user@merchant.example.com/', 'credentials_in_url'],
    ['not a url', 'invalid_url'],
    ['', 'invalid_url'],
    ['https://', 'invalid_url'],
    [`https://merchant.example.com/${'a'.repeat(3000)}`, 'url_too_long'],
  ])('refuses %p (%s)', (raw, reason) => {
    expect(reasonOf(raw)).toBe(reason);
  });

  it.each([
    'https://localhost/hook', 'https://LOCALHOST/hook', 'https://localhost./hook', 'https://api.localhost/hook', 'https://printer.local/hook',
    'https://db.internal/hook', 'https://router.lan/hook', 'https://x.home.arpa/hook',
  ])('refuses the internal name %p', (raw) => {
    expect(reasonOf(raw)).toBe('forbidden_host');
  });

  it.each([
    'https://127.0.0.1/hook', 'https://10.1.2.3/hook', 'https://192.168.0.1/hook', 'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/hook', 'https://[fd00::1]/hook', 'https://[::ffff:127.0.0.1]/hook', 'https://[::ffff:7f00:1]/hook',
    // addresses people write to dodge a text filter: the URL parser turns every one of them into 127.0.0.1 / 169.254.169.254
    'https://2130706433/hook', 'https://0x7f000001/hook', 'https://0177.0.0.1/hook', 'https://127.1/hook', 'https://0x7f.1/hook',
    'https://2852039166/latest/meta-data/', 'https://0xa9fea9fe/', 'https://0/', 'https://0.0.0.0/',
  ])('refuses the address %p however it is spelled', (raw) => {
    expect(reasonOf(raw)).toBe('forbidden_address');
  });

  it.each(['https://merchant.example.com:22/hook', 'https://merchant.example.com:25/', 'https://merchant.example.com:1/', 'https://merchant.example.com:1023/'])(
    'refuses a low port: %p',
    (raw) => {
      expect(reasonOf(raw)).toBe('port_not_allowed');
    },
  );

  it('allows 443 and any port from 1024 up', () => {
    expect(reasonOf('https://merchant.example.com:443/')).toBeUndefined();
    expect(reasonOf('https://merchant.example.com:1024/')).toBeUndefined();
    expect(reasonOf('https://merchant.example.com:65535/')).toBeUndefined();
  });

  it('the parser, not a regex, decides the host, and the host it decides is the one we connect to', () => {
    // WHATWG parsing treats the backslash as a slash, so the host here really is example.com; what is checked is what is used.
    expect(checkWebhookUrl('https://example.com\\@127.0.0.1/').hostname).toBe('example.com');
    expect(reasonOf('https://127.0.0.1#@example.com/')).toBe('forbidden_address'); // a fragment cannot hide the real host
    expect(reasonOf('https://example.com@127.0.0.1/')).toBe('credentials_in_url');
  });

  describe('development policy', () => {
    it('allows http when asked', () => {
      expect(reasonOf('http://merchant.example.com/hook', { allowHttp: true, allowPrivateNetworks: false })).toBeUndefined();
      expect(reasonOf('ftp://merchant.example.com/hook', { allowHttp: true, allowPrivateNetworks: false })).toBe('scheme_not_allowed');
    });
    it('allows internal hosts only when asked', () => {
      const dev = { allowHttp: true, allowPrivateNetworks: true };
      expect(reasonOf('http://localhost:4000/hook', dev)).toBeUndefined();
      expect(reasonOf('http://127.0.0.1:4000/hook', dev)).toBeUndefined();
      expect(reasonOf('http://127.0.0.1:4000/hook', { allowHttp: true, allowPrivateNetworks: false })).toBe('forbidden_address');
    });
    it('credentials are refused even in development', () => {
      expect(reasonOf('http://a:b@localhost/', { allowHttp: true, allowPrivateNetworks: true })).toBe('credentials_in_url');
    });
  });
});

describe('assertAddressesAllowed', () => {
  it('passes public addresses', () => {
    expect(() => assertAddressesAllowed(['93.184.216.34', '2606:4700:4700::1111'], STRICT_URL_POLICY)).not.toThrow();
  });

  it('refuses if ANY address is internal: a record set mixing public and private is the rebinding trick', () => {
    expect(() => assertAddressesAllowed(['93.184.216.34', '10.0.0.5'], STRICT_URL_POLICY)).toThrow(UnsafeUrlError);
    expect(() => assertAddressesAllowed(['2606:4700:4700::1111', '::ffff:10.0.0.5'], STRICT_URL_POLICY)).toThrow(UnsafeUrlError);
  });

  it('refuses a name that resolved to nothing', () => {
    expect(() => assertAddressesAllowed([], STRICT_URL_POLICY)).toThrow(UnsafeUrlError);
  });

  it('is skipped on a development policy', () => {
    expect(() => assertAddressesAllowed(['127.0.0.1'], { allowHttp: true, allowPrivateNetworks: true })).not.toThrow();
  });
});

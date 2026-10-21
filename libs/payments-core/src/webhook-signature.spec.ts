import {
  DEFAULT_TOLERANCE_SECONDS,
  signWebhook,
  verifyWebhook,
  WebhookSignatureError,
} from './webhook-signature';
import type { WebhookSignatureFailure } from './webhook-signature';

const secret = 'whsec_test';
const payload = '{"id":"evt_1"}';
const now = 1_700_000_000;

function reasonOf(fn: () => unknown): WebhookSignatureFailure {
  try {
    fn();
  } catch (error) {
    if (error instanceof WebhookSignatureError) return error.reason;
    throw error;
  }
  throw new Error('expected the signature to be rejected');
}

describe('signWebhook', () => {
  it('matches a known answer computed independently with HMAC-SHA256 over "<t>.<body>"', () => {
    expect(signWebhook({ secret, payload, timestamp: now })).toBe(
      `t=${now},v1=c89214b5b5da833daed6f0b8c5bb6bd58cea9022bd80ccc78230f3942d632925`,
    );
  });

  it('signs bytes and strings identically', () => {
    expect(signWebhook({ secret, payload: Buffer.from(payload), timestamp: now })).toBe(
      signWebhook({ secret, payload, timestamp: now }),
    );
  });
});

describe('verifyWebhook', () => {
  const header = signWebhook({ secret, payload, timestamp: now });
  const verify = (over: Partial<Parameters<typeof verifyWebhook>[0]> = {}) =>
    verifyWebhook({ secret, header, payload, nowSeconds: now, ...over });

  it('accepts a genuine, fresh signature and returns its timestamp', () => {
    expect(verify()).toEqual({ timestamp: now });
  });

  it('accepts the raw bytes as a Buffer', () => {
    expect(() => verify({ payload: Buffer.from(payload) })).not.toThrow();
  });

  it('rejects a body changed by even one byte', () => {
    expect(reasonOf(() => verify({ payload: '{"id":"evt_2"}' }))).toBe('signature_mismatch');
  });

  it('rejects a re-serialized body: signatures cover the exact bytes received', () => {
    const reformatted = JSON.stringify(JSON.parse('{ "id" : "evt_1" }'));
    const signedPretty = signWebhook({ secret, payload: '{ "id" : "evt_1" }', timestamp: now });
    expect(reasonOf(() => verify({ header: signedPretty, payload: reformatted }))).toBe('signature_mismatch');
  });

  it('rejects the wrong secret', () => {
    expect(reasonOf(() => verify({ secret: 'whsec_other' }))).toBe('signature_mismatch');
  });

  it('rejects a timestamp edited to look fresh, because the MAC covers it', () => {
    const old = signWebhook({ secret, payload, timestamp: now - 10_000 });
    const relabelled = old.replace(`t=${now - 10_000}`, `t=${now}`);
    expect(reasonOf(() => verify({ header: relabelled }))).toBe('signature_mismatch');
  });

  describe('timestamp tolerance (replay protection)', () => {
    it.each([
      ['exactly at the limit', now - DEFAULT_TOLERANCE_SECONDS, true],
      ['one second too old', now - DEFAULT_TOLERANCE_SECONDS - 1, false],
      ['one second too far in the future', now + DEFAULT_TOLERANCE_SECONDS + 1, false],
    ])('%s', (_name, timestamp, ok) => {
      const signed = signWebhook({ secret, payload, timestamp });
      if (ok) {
        expect(() => verify({ header: signed })).not.toThrow();
      } else {
        expect(reasonOf(() => verify({ header: signed }))).toBe('timestamp_out_of_tolerance');
      }
    });

    it('honours a custom tolerance', () => {
      const signed = signWebhook({ secret, payload, timestamp: now - 60 });
      expect(reasonOf(() => verify({ header: signed, toleranceSeconds: 30 }))).toBe('timestamp_out_of_tolerance');
    });
  });

  describe('secret rotation', () => {
    it('accepts a signature made with any of several current secrets', () => {
      expect(() => verify({ secret: ['whsec_new', secret] })).not.toThrow();
      expect(() => verify({ secret: [secret, 'whsec_new'] })).not.toThrow();
    });

    it('accepts a header that carries both an old and a new signature', () => {
      const both = `t=${now},v1=${'0'.repeat(64)},v1=${header.split('v1=')[1]}`;
      expect(() => verify({ header: both })).not.toThrow();
    });

    it('still rejects when none of the secrets match', () => {
      expect(reasonOf(() => verify({ secret: ['a', 'b'] }))).toBe('signature_mismatch');
    });
  });

  describe('malformed headers', () => {
    it.each([undefined, '', '   '])('treats %j as missing', (value) => {
      expect(reasonOf(() => verify({ header: value }))).toBe('missing_header');
    });

    it.each([
      ['no timestamp', `v1=${'a'.repeat(64)}`],
      ['no signature', `t=${now}`],
      ['no equals sign', 'garbage'],
      ['a non-numeric timestamp', `t=abc,v1=${'a'.repeat(64)}`],
      ['a negative timestamp', `t=-5,v1=${'a'.repeat(64)}`],
      ['two timestamps', `t=${now},t=${now},v1=${'a'.repeat(64)}`],
      ['a short signature', `t=${now},v1=abcd`],
      ['an uppercase signature', `t=${now},v1=${'A'.repeat(64)}`],
      ['a non-hex signature', `t=${now},v1=${'g'.repeat(64)}`],
    ])('rejects %s', (_name, bad) => {
      expect(reasonOf(() => verify({ header: bad }))).toBe('malformed_header');
    });

    it('ignores unknown signature schemes so the format can grow', () => {
      expect(() => verify({ header: `${header},v0=whatever` })).not.toThrow();
    });
  });
});

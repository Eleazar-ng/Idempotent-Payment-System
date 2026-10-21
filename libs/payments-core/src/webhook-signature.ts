import { createHmac, timingSafeEqual } from 'node:crypto';

/** The HTTP header (lowercase, as Node exposes it) that carries the signature. */
export const WEBHOOK_SIGNATURE_HEADER = 'processor-signature';

/** Reject signatures older (or further in the future) than this, to blunt replayed deliveries. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type WebhookSignatureFailure =
  | 'missing_header'
  | 'malformed_header'
  | 'signature_mismatch'
  | 'timestamp_out_of_tolerance';

/** Why a webhook was refused. The reason is for logs; callers answer 400 whatever it is. */
export class WebhookSignatureError extends Error {
  readonly code = 'WEBHOOK_SIGNATURE_INVALID';

  constructor(readonly reason: WebhookSignatureFailure) {
    super(`Webhook signature rejected: ${reason}`);
    this.name = 'WebhookSignatureError';
  }
}

type Payload = string | Uint8Array;

function mac(secret: string, timestamp: number, payload: Payload): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest('hex');
}

/**
 * Signs the EXACT bytes of a webhook body. Format: `t=<unix seconds>,v1=<hex hmac-sha256>`, where
 * the MAC covers `"<t>." + body`. Binding the timestamp into the MAC stops an attacker from
 * re-labelling an old delivery as fresh (Module 7).
 */
export function signWebhook(args: { secret: string; payload: Payload; timestamp: number }): string {
  return `t=${args.timestamp},v1=${mac(args.secret, args.timestamp, args.payload)}`;
}

export interface VerifyWebhookArgs {
  /** One secret, or several during a rotation: a signature from any of them is accepted. */
  secret: string | readonly string[];
  header: string | undefined;
  /** The raw request bytes. Never a re-serialized copy of the parsed JSON. */
  payload: Payload;
  nowSeconds?: number;
  toleranceSeconds?: number;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Verifies a webhook signature, or throws WebhookSignatureError. Returns the signed timestamp.
 *
 * Checks, in order: header present and well formed; at least one `v1` signature matches (constant
 * time compare); the timestamp is within tolerance. A valid but old signature therefore reports
 * `timestamp_out_of_tolerance`, which is much easier to diagnose than a generic mismatch.
 */
export function verifyWebhook(args: VerifyWebhookArgs): { timestamp: number } {
  if (args.header === undefined || args.header.trim() === '') {
    throw new WebhookSignatureError('missing_header');
  }

  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of args.header.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) throw new WebhookSignatureError('malformed_header');
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (name === 't') {
      if (timestamp !== undefined || !/^\d{1,12}$/.test(value)) {
        throw new WebhookSignatureError('malformed_header');
      }
      timestamp = Number(value);
    } else if (name === 'v1') {
      if (!HEX_64.test(value)) throw new WebhookSignatureError('malformed_header');
      signatures.push(value);
    }
    // Unknown schemes (v0, v2...) are ignored so the format can grow.
  }
  if (timestamp === undefined || signatures.length === 0) {
    throw new WebhookSignatureError('malformed_header');
  }

  const secrets = typeof args.secret === 'string' ? [args.secret] : args.secret;
  const matched = secrets.some((secret) => {
    const expected = Buffer.from(mac(secret, timestamp as number, args.payload), 'hex');
    return signatures.some((candidate) => timingSafeEqual(expected, Buffer.from(candidate, 'hex')));
  });
  if (!matched) throw new WebhookSignatureError('signature_mismatch');

  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (args.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) {
    throw new WebhookSignatureError('timestamp_out_of_tolerance');
  }
  return { timestamp };
}

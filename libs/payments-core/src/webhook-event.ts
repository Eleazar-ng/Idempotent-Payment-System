import { z } from 'zod';

/** The body of a webhook delivery could not be understood. A retry of the same bytes cannot fix it. */
export class WebhookPayloadError extends Error {
  readonly code = 'WEBHOOK_PAYLOAD_INVALID';

  constructor(reason: string) {
    super(`Invalid webhook payload: ${reason}`);
    this.name = 'WebhookPayloadError';
  }
}

const chargeSchema = z.object({
  id: z.string().min(1).max(255),
  amount: z.number().int().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  status: z.string(),
  failure_code: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const envelopeSchema = z.object({
  id: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  created: z.number().int().optional(),
  data: z.object({ object: z.unknown() }),
});

export interface ChargeEventData {
  chargeId: string;
  amount: number;
  currency: string;
  /** The processor idempotency key we sent as `metadata.reference`: how a charge finds its attempt. */
  reference: string | undefined;
  failureCode: string | undefined;
}

export type WebhookEvent =
  | { kind: 'charge_succeeded'; eventId: string; type: string; charge: ChargeEventData }
  | { kind: 'charge_failed'; eventId: string; type: string; charge: ChargeEventData }
  /** A well-formed event of a type we do not act on. Acknowledged so the processor stops resending it. */
  | { kind: 'ignored'; eventId: string; type: string };

/**
 * Turns the raw bytes of a verified delivery into an event we can act on.
 *
 * Only call this AFTER the signature has been verified against the same bytes. Unknown event types
 * are not an error (processors add types over time); a known type with a malformed body is.
 */
export function parseWebhookEvent(rawBody: Uint8Array | string): { event: WebhookEvent; payload: unknown } {
  let payload: unknown;
  try {
    payload = JSON.parse(typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8'));
  } catch {
    throw new WebhookPayloadError('body is not JSON');
  }

  const envelope = envelopeSchema.safeParse(payload);
  if (!envelope.success) throw new WebhookPayloadError('missing id, type or data');
  const { id: eventId, type } = envelope.data;

  if (type !== 'charge.succeeded' && type !== 'charge.failed') {
    return { event: { kind: 'ignored', eventId, type }, payload };
  }

  const charge = chargeSchema.safeParse(envelope.data.data.object);
  if (!charge.success) throw new WebhookPayloadError(`${type} has no valid charge`);
  const data: ChargeEventData = {
    chargeId: charge.data.id,
    amount: charge.data.amount,
    currency: charge.data.currency,
    reference: charge.data.metadata?.reference,
    failureCode: charge.data.failure_code ?? undefined,
  };
  return {
    event: { kind: type === 'charge.succeeded' ? 'charge_succeeded' : 'charge_failed', eventId, type, charge: data },
    payload,
  };
}

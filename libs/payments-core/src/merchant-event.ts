/** The header merchants verify. Same scheme as the processor's webhooks: `t=<unix>,v1=<hmac>` over `"<t>." + raw body`. */
export const PLATFORM_SIGNATURE_HEADER = 'platform-signature';
/** Stable per event; merchants dedupe on it, because delivery is at least once. */
export const EVENT_ID_HEADER = 'x-event-id';

export interface MerchantEventInput {
  /** The outbox row id. */
  id: number;
  eventType: string;
  createdAt: Date;
  payload: unknown;
}

/** The event id merchants see. Derived from the outbox row, so every retry carries the same one. */
export const merchantEventId = (outboxId: number): string => `evt_out_${outboxId}`;

/**
 * The exact body sent to a merchant. A pure function of the stored row, so a retry sends identical
 * bytes (apart from the signature timestamp) and a merchant that deduplicates by id sees one event.
 */
export function buildMerchantEventBody(input: MerchantEventInput): string {
  return JSON.stringify({
    id: merchantEventId(input.id),
    object: 'event',
    type: input.eventType,
    created: Math.floor(input.createdAt.getTime() / 1000),
    data: { object: input.payload },
  });
}

/**
 * What a processor answer MEANS for us. Everything the payment flow decides (move the attempt to
 * failed? retry? wait?) is decided from this type, never from raw HTTP codes (Module 2.3 and 5.5).
 *
 * The line that matters is between a definitive answer and an ambiguous one:
 *
 *  - succeeded / requires_action / processing / declined / rejected: the processor TOLD us
 *    what happened (or that it refused to do anything). The attempt can move on.
 *  - unknown: we do not know whether money moved. The ONLY safe responses are to ask again with
 *    the SAME processor idempotency key, or to look the charge up later. Failing the attempt here
 *    would let a customer pay twice.
 */
export type ProcessorOutcome =
  | { kind: 'succeeded'; chargeId: string }
  | { kind: 'requires_action'; chargeId: string }
  | { kind: 'processing'; chargeId: string }
  /** The card was refused. Money did not move. A new attempt may be tried. */
  | { kind: 'declined'; code: string; chargeId?: string }
  /** The processor refused the REQUEST itself (bad parameters, bad credentials). Nothing was charged. */
  | { kind: 'rejected'; code: string }
  | { kind: 'unknown'; reason: string };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/**
 * Classifies an HTTP answer from POST /v1/charges. Anything unexpected is `unknown`, because the
 * cost of wrongly calling an answer definitive (a double charge or a wrongly failed payment) is far
 * higher than the cost of asking again.
 */
export function classifyChargeResponse(status: number, body: unknown): ProcessorOutcome {
  const data = asRecord(body);
  const error = asRecord(data.error);

  if (status === 200) {
    const chargeId = str(data.id);
    if (data.object !== 'charge' || !chargeId) return { kind: 'unknown', reason: 'malformed_response' };
    switch (data.status) {
      case 'succeeded':
        return { kind: 'succeeded', chargeId };
      case 'requires_action':
        return { kind: 'requires_action', chargeId };
      case 'pending':
        return { kind: 'processing', chargeId };
      case 'failed':
        return { kind: 'declined', code: str(data.failure_code) ?? 'card_declined', chargeId };
      default:
        return { kind: 'unknown', reason: 'malformed_response' };
    }
  }

  if (status === 402) {
    return { kind: 'declined', code: str(error.code) ?? 'card_declined', chargeId: str(error.charge) };
  }

  // 400 idempotency_key_reused means a charge with this key already exists under different
  // parameters: that is a bug on our side and a charge may exist, so it is NOT a clean refusal.
  if (status === 400 && error.code === 'idempotency_key_reused') {
    return { kind: 'unknown', reason: 'idempotency_key_reused' };
  }

  // 408 timeout, 409 key still in use at the processor, 429 slow down: the request may have been
  // (or still be being) processed. Ask again with the same key.
  if (status === 408 || status === 409 || status === 429) {
    return { kind: 'unknown', reason: `http_${status}` };
  }

  // Other 4xx: the processor refused this request. It did nothing.
  if (status >= 400 && status < 500) {
    return { kind: 'rejected', code: str(error.code) ?? `http_${status}` };
  }

  // 5xx and anything else (redirects, 1xx...): ambiguous by definition.
  return { kind: 'unknown', reason: `http_${status}` };
}

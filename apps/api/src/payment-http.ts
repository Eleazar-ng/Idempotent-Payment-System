import { derivePaymentStatus } from '@app/payments-core';
import type { PaymentStatus } from '@app/payments-core';
import type { PaymentAttempt, PaymentIntent } from '@app/db';

/** What the HTTP layer sends: status, JSON body, extra headers. */
export interface HttpResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

export function problem(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): HttpResult {
  return { status, body: { error: { code, message }, ...extra }, headers };
}

export interface PaymentView {
  id: string;
  object: 'payment';
  order_id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  failure_code: string | null;
  attempt: { id: string; number: number; status: string } | null;
}

/** The public shape of a payment: the order plus the outcome of its latest attempt. */
export function paymentView(intent: PaymentIntent, latest: PaymentAttempt | undefined): PaymentView {
  return {
    id: `pay_${intent.id}`,
    object: 'payment',
    order_id: intent.order_id,
    amount: intent.amount,
    currency: intent.currency,
    status: derivePaymentStatus(latest?.status),
    failure_code: latest?.status === 'failed' ? latest.failure_reason : null,
    attempt: latest ? { id: `att_${latest.id}`, number: latest.attempt_number, status: latest.status } : null,
  };
}

/**
 * The HTTP response for a payment in its current state. This is also what gets stored under the
 * idempotency key, so replays return exactly this.
 *
 *   succeeded        201  paid
 *   processing       202  we are still finding out; poll GET /v1/payments/:id
 *   requires_action  200  the customer must complete a step (3-D Secure)
 *   failed           402  the card was declined (money did not move; a new attempt is allowed)
 *   failed (ours)    502  the processor refused OUR request; not the customer's fault
 */
export function paymentResult(intent: PaymentIntent, latest: PaymentAttempt | undefined): HttpResult {
  const view = paymentView(intent, latest);
  const status = {
    succeeded: 201,
    processing: 202,
    requires_action: 200,
    failed: latest?.failure_reason?.startsWith('processor_rejected') ? 502 : 402,
  }[view.status];
  return { status, body: view, headers: {} };
}

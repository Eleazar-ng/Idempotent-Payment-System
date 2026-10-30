export { paymentResult, paymentView } from '@app/db';
export type { PaymentView } from '@app/db';

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

import { parseWebhookEvent, WebhookPayloadError } from './webhook-event';

const charge = (over: Record<string, unknown> = {}) => ({
  id: 'ch_1',
  object: 'charge',
  amount: 5000,
  currency: 'NGN',
  status: 'succeeded',
  failure_code: null,
  metadata: { reference: 'pi_1_a1' },
  ...over,
});
const body = (type: string, object: unknown, id = 'evt_1') =>
  JSON.stringify({ id, object: 'event', type, created: 1, data: { object } });

describe('parseWebhookEvent', () => {
  it('reads a charge.succeeded event', () => {
    const { event } = parseWebhookEvent(body('charge.succeeded', charge()));
    expect(event).toEqual({
      kind: 'charge_succeeded',
      eventId: 'evt_1',
      type: 'charge.succeeded',
      charge: { chargeId: 'ch_1', amount: 5000, currency: 'NGN', reference: 'pi_1_a1', failureCode: undefined },
    });
  });

  it('reads a charge.failed event with its failure code', () => {
    const { event } = parseWebhookEvent(
      body('charge.failed', charge({ status: 'failed', failure_code: 'insufficient_funds' })),
    );
    expect(event).toMatchObject({ kind: 'charge_failed', charge: { failureCode: 'insufficient_funds' } });
  });

  it('accepts raw bytes as well as a string', () => {
    const { event } = parseWebhookEvent(Buffer.from(body('charge.succeeded', charge())));
    expect(event.kind).toBe('charge_succeeded');
  });

  it('has no reference when the charge carries no metadata', () => {
    const { event } = parseWebhookEvent(body('charge.succeeded', charge({ metadata: undefined })));
    expect(event).toMatchObject({ charge: { reference: undefined } });
  });

  it('acknowledges unknown types instead of failing, whatever their body', () => {
    const { event } = parseWebhookEvent(body('payout.paid', { anything: true }, 'evt_9'));
    expect(event).toEqual({ kind: 'ignored', eventId: 'evt_9', type: 'payout.paid' });
  });

  it('returns the parsed payload for storage', () => {
    const { payload } = parseWebhookEvent(body('charge.succeeded', charge()));
    expect(payload).toMatchObject({ id: 'evt_1' });
  });

  it.each([
    ['not JSON', 'nope'],
    ['an array', '[]'],
    ['no id', JSON.stringify({ type: 'charge.succeeded', data: { object: charge() } })],
    ['no type', JSON.stringify({ id: 'e', data: { object: charge() } })],
    ['no data', JSON.stringify({ id: 'e', type: 'charge.succeeded' })],
    ['an empty id', body('charge.succeeded', charge(), '')],
  ])('refuses %s', (_name, raw) => {
    expect(() => parseWebhookEvent(raw)).toThrow(WebhookPayloadError);
  });

  it.each([
    ['no charge', null],
    ['a charge with no id', charge({ id: undefined })],
    ['a fractional amount', charge({ amount: 10.5 })],
    ['a zero amount', charge({ amount: 0 })],
    ['a lowercase currency', charge({ currency: 'ngn' })],
    ['non-string metadata', charge({ metadata: { reference: 5 } })],
  ])('refuses a known type with %s', (_name, object) => {
    expect(() => parseWebhookEvent(body('charge.succeeded', object))).toThrow(WebhookPayloadError);
  });
});

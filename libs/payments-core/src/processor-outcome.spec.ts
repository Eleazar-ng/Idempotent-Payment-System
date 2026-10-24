import { processorIdempotencyKey } from './attempt-keys';
import { derivePaymentStatus } from './payment-status';
import { attemptMachine } from './payment-states';
import { classifyChargeResponse } from './processor-outcome';

const charge = (status: string, over: Record<string, unknown> = {}) => ({
  id: 'ch_1',
  object: 'charge',
  status,
  failure_code: null,
  ...over,
});

describe('classifyChargeResponse', () => {
  it.each([
    ['succeeded', { kind: 'succeeded', chargeId: 'ch_1' }],
    ['requires_action', { kind: 'requires_action', chargeId: 'ch_1' }],
    ['pending', { kind: 'processing', chargeId: 'ch_1' }],
  ])('a 200 charge that is %s', (status, expected) => {
    expect(classifyChargeResponse(200, charge(status))).toEqual(expected);
  });

  it('a 200 charge that is failed is a decline, carrying its code', () => {
    expect(classifyChargeResponse(200, charge('failed', { failure_code: 'expired_card' }))).toEqual({
      kind: 'declined',
      code: 'expired_card',
      chargeId: 'ch_1',
    });
  });

  it('a 402 is a decline with the processor’s code and charge id', () => {
    expect(
      classifyChargeResponse(402, { error: { type: 'card_error', code: 'insufficient_funds', charge: 'ch_9' } }),
    ).toEqual({ kind: 'declined', code: 'insufficient_funds', chargeId: 'ch_9' });
  });

  it('a 402 with no usable body is still a decline', () => {
    expect(classifyChargeResponse(402, null)).toEqual({ kind: 'declined', code: 'card_declined', chargeId: undefined });
  });

  describe('everything ambiguous is unknown, never a failure', () => {
    it.each([500, 502, 503, 504, 599, 408, 409, 429, 301, 100])('HTTP %i', (status) => {
      expect(classifyChargeResponse(status, { error: { code: 'whatever' } })).toMatchObject({ kind: 'unknown' });
    });

    it.each([
      ['no body', undefined],
      ['a string body', 'ok'],
      ['no id', { object: 'charge', status: 'succeeded' }],
      ['an empty id', { object: 'charge', status: 'succeeded', id: '' }],
      ['a wrong object type', { object: 'refund', id: 'x', status: 'succeeded' }],
      ['an unknown status', charge('teleported')],
      ['a numeric status', charge('1')],
    ])('a 200 with %s', (_name, body) => {
      expect(classifyChargeResponse(200, body)).toEqual({ kind: 'unknown', reason: 'malformed_response' });
    });

    it('idempotency_key_reused: a charge may already exist, so it is not a clean refusal', () => {
      expect(classifyChargeResponse(400, { error: { code: 'idempotency_key_reused' } })).toEqual({
        kind: 'unknown',
        reason: 'idempotency_key_reused',
      });
    });

    it('a 200 never classifies as succeeded without a charge id we can reconcile', () => {
      expect(classifyChargeResponse(200, { object: 'charge', status: 'succeeded' }).kind).not.toBe('succeeded');
    });
  });

  describe('a refusal of the request itself is rejected, not unknown', () => {
    it.each([400, 401, 403, 404, 422])('HTTP %i', (status) => {
      expect(classifyChargeResponse(status, { error: { code: 'parameter_invalid' } })).toEqual({
        kind: 'rejected',
        code: 'parameter_invalid',
      });
    });

    it('falls back to the HTTP code when the body has none', () => {
      expect(classifyChargeResponse(404, {})).toEqual({ kind: 'rejected', code: 'http_404' });
    });
  });
});

describe('processorIdempotencyKey', () => {
  it('is derived, so every retry of an attempt sends the same key', () => {
    expect(processorIdempotencyKey(42, 1)).toBe('pi_42_a1');
    expect(processorIdempotencyKey(42, 1)).toBe(processorIdempotencyKey(42, 1));
  });

  it('differs for a new attempt and for a different intent', () => {
    const keys = [processorIdempotencyKey(42, 1), processorIdempotencyKey(42, 2), processorIdempotencyKey(43, 1)];
    expect(new Set(keys).size).toBe(3);
  });

  it('cannot collide through concatenation ambiguity (1,11 vs 11,1)', () => {
    expect(processorIdempotencyKey(1, 11)).not.toBe(processorIdempotencyKey(11, 1));
  });

  it.each([[0, 1], [1, 0], [-1, 1], [1.5, 1], [1, Number.NaN]])('refuses (%p, %p)', (intent, attempt) => {
    expect(() => processorIdempotencyKey(intent, attempt)).toThrow(RangeError);
  });
});

describe('derivePaymentStatus', () => {
  it.each([
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
    ['requires_action', 'requires_action'],
    ['created', 'processing'],
    ['calling_processor', 'processing'],
    ['processing', 'processing'],
    ['abandoned', 'processing'], // outcome unknown: never advertised as failed
    [undefined, 'processing'],
  ] as const)('latest attempt %s is shown as %s', (attempt, expected) => {
    expect(derivePaymentStatus(attempt)).toBe(expected);
  });

  it('covers every attempt status', () => {
    for (const status of attemptMachine.statuses) {
      expect(['succeeded', 'processing', 'requires_action', 'failed']).toContain(derivePaymentStatus(status));
    }
  });
});

import { buildMerchantEventBody, merchantEventId } from './merchant-event';

const input = {
  id: 42,
  eventType: 'payment.succeeded',
  createdAt: new Date('2026-10-28T10:00:00.900Z'),
  payload: { payment_id: 'pay_7', amount: 5000 },
};

describe('buildMerchantEventBody', () => {
  it('wraps the stored payload in the event envelope', () => {
    expect(JSON.parse(buildMerchantEventBody(input))).toEqual({
      id: 'evt_out_42',
      object: 'event',
      type: 'payment.succeeded',
      created: 1793181600,
      data: { object: { payment_id: 'pay_7', amount: 5000 } },
    });
  });

  it('is byte-for-byte the same every time (retries must not change the body)', () => {
    expect(buildMerchantEventBody(input)).toBe(buildMerchantEventBody({ ...input }));
  });

  it('derives the event id from the outbox row only', () => {
    expect(merchantEventId(42)).toBe('evt_out_42');
    expect(merchantEventId(43)).not.toBe(merchantEventId(42));
  });
});

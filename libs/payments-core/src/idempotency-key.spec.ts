import { assertValidIdempotencyKey } from './idempotency-key';
import { InvalidIdempotencyKeyError } from './errors';
import { conflictResponse } from './idempotency-http';

describe('assertValidIdempotencyKey', () => {
  it.each(['a', 'order-123:attempt/1', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 'x'.repeat(255), '~!@#$%^&*()'])(
    'accepts %s',
    (key) => {
      expect(() => assertValidIdempotencyKey(key)).not.toThrow();
    },
  );

  it.each([
    ['empty', ''],
    ['256 characters', 'x'.repeat(256)],
    ['a space', 'has space'],
    ['a leading space', ' key'],
    ['a tab', 'a\tb'],
    ['a newline', 'a\nb'],
    ['unicode', 'clé'],
    ['an emoji', 'key😀'],
    ['a null byte', 'a\u0000b'],
    ['a number', 42],
    ['undefined', undefined],
    ['null', null],
    ['an array', ['a']],
  ])('rejects %s', (_name, key) => {
    expect(() => assertValidIdempotencyKey(key)).toThrow(InvalidIdempotencyKeyError);
  });
});

describe('conflictResponse', () => {
  it('in-flight is a retryable 409', () => {
    const response = conflictResponse('in_flight');
    expect(response.status).toBe(409);
    expect(response.retryAfterSeconds).toBeGreaterThan(0);
    expect(response.body.error.code).toBe('idempotency_request_in_progress');
  });

  it('a reused key is a 422 that can never succeed on retry, so no Retry-After', () => {
    const response = conflictResponse('mismatch');
    expect(response.status).toBe(422);
    expect(response.retryAfterSeconds).toBeUndefined();
    expect(response.body.error.code).toBe('idempotency_key_reused');
  });
});

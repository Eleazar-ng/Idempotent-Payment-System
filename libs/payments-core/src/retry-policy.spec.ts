import { backoffCeilingMs, parseRetryAfterMs, retryDelayMs } from './retry-policy';
import type { RetryPolicy } from './retry-policy';

const policy: RetryPolicy = { baseDelayMs: 100, maxDelayMs: 1000 };

describe('backoffCeilingMs', () => {
  it('doubles each retry', () => {
    expect([0, 1, 2, 3].map((n) => backoffCeilingMs(policy, n))).toEqual([100, 200, 400, 800]);
  });

  it('stops growing at the maximum', () => {
    expect([4, 5, 10, 50].map((n) => backoffCeilingMs(policy, n))).toEqual([1000, 1000, 1000, 1000]);
  });

  it('does not overflow for absurd retry numbers', () => {
    expect(backoffCeilingMs(policy, 5000)).toBe(1000);
  });

  it('honours a custom multiplier', () => {
    expect(backoffCeilingMs({ ...policy, multiplier: 3 }, 2)).toBe(900);
  });

  it('is constant with a multiplier of 1', () => {
    expect(backoffCeilingMs({ ...policy, multiplier: 1 }, 7)).toBe(100);
  });

  it.each([
    ['negative base', { baseDelayMs: -1, maxDelayMs: 10 }],
    ['max below base', { baseDelayMs: 100, maxDelayMs: 99 }],
    ['NaN base', { baseDelayMs: NaN, maxDelayMs: 10 }],
    ['infinite max', { baseDelayMs: 1, maxDelayMs: Infinity }],
    ['multiplier below 1', { baseDelayMs: 1, maxDelayMs: 10, multiplier: 0.5 }],
  ])('refuses a policy with %s', (_name, bad) => {
    expect(() => backoffCeilingMs(bad, 0)).toThrow(RangeError);
  });

  it.each([-1, 1.5, NaN])('refuses retry number %s', (n) => {
    expect(() => backoffCeilingMs(policy, n)).toThrow(RangeError);
  });
});

describe('retryDelayMs', () => {
  it('full jitter spans zero to the ceiling', () => {
    expect(retryDelayMs(policy, 2, { random: () => 0 })).toBe(0);
    expect(retryDelayMs(policy, 2, { random: () => 0.5 })).toBe(200);
    expect(retryDelayMs(policy, 2, { random: () => 0.999999 })).toBe(399);
  });

  it('full jitter is the default', () => {
    expect(retryDelayMs(policy, 1, { random: () => 0.5 })).toBe(100);
  });

  it('equal jitter keeps half the ceiling as a guaranteed minimum', () => {
    const equal: RetryPolicy = { ...policy, jitter: 'equal' };
    expect(retryDelayMs(equal, 2, { random: () => 0 })).toBe(200);
    expect(retryDelayMs(equal, 2, { random: () => 0.5 })).toBe(300);
  });

  it('no jitter gives exactly the ceiling', () => {
    expect(retryDelayMs({ ...policy, jitter: 'none' }, 3, { random: () => 0.1 })).toBe(800);
  });

  it('never exceeds the ceiling, whatever the random source returns', () => {
    for (let n = 0; n < 8; n++) {
      for (const draw of [0, 0.25, 0.5, 0.75, 0.999999999]) {
        const d = retryDelayMs(policy, n, { random: () => draw });
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(backoffCeilingMs(policy, n));
      }
    }
  });

  it('actually varies with real randomness (the point of jitter)', () => {
    const delays = new Set(Array.from({ length: 50 }, () => retryDelayMs(policy, 3)));
    expect(delays.size).toBeGreaterThan(10);
  });

  it('returns whole milliseconds', () => {
    expect(Number.isInteger(retryDelayMs(policy, 1, { random: () => 0.123456 }))).toBe(true);
  });

  it('honours a Retry-After floor above the jittered delay', () => {
    expect(retryDelayMs(policy, 0, { random: () => 0, minDelayMs: 700 })).toBe(700);
  });

  it('does not let a Retry-After floor exceed the policy maximum', () => {
    expect(retryDelayMs(policy, 0, { random: () => 0, minDelayMs: 86_400_000 })).toBe(1000);
  });

  it('ignores a floor below the jittered delay and a negative floor', () => {
    expect(retryDelayMs(policy, 2, { random: () => 0.5, minDelayMs: 50 })).toBe(200);
    expect(retryDelayMs(policy, 2, { random: () => 0.5, minDelayMs: -5 })).toBe(200);
  });

  it.each([-0.1, 1, NaN])('refuses a random source that returns %s', (draw) => {
    expect(() => retryDelayMs(policy, 0, { random: () => draw })).toThrow(RangeError);
  });
});

describe('parseRetryAfterMs', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');

  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs('30', now)).toBe(30_000);
    expect(parseRetryAfterMs(' 0 ', now)).toBe(0);
  });

  it('reads an HTTP date', () => {
    expect(parseRetryAfterMs('Tue, 27 Oct 2026 12:00:45 GMT', now)).toBe(45_000);
  });

  it('treats a date in the past as zero', () => {
    expect(parseRetryAfterMs('Tue, 27 Oct 2026 11:00:00 GMT', now)).toBe(0);
  });

  it.each([undefined, null, '', 'soon', '-5', '1.5', '99999999999'])('ignores %s', (value) => {
    expect(parseRetryAfterMs(value as string | null | undefined, now)).toBeUndefined();
  });
});

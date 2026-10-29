/**
 * How long to wait before trying again (Module 7).
 *
 * Plain exponential backoff has a flaw: every client that failed at the same moment (a processor
 * blip, a merchant endpoint restarting) retries at the same later moments, so the recovering service
 * is hit by synchronized waves. Jitter spreads them out. "Full" jitter, the default, picks uniformly
 * between 0 and the exponential ceiling, which gives the lowest total load for the same recovery time.
 *
 * Pure on purpose: the random source is a parameter, so tests can pin it.
 */
export interface RetryPolicy {
  /** The ceiling for the first retry, before jitter. */
  baseDelayMs: number;
  /** No delay ever exceeds this, however many retries have happened. */
  maxDelayMs: number;
  /** Growth per retry. Default 2. */
  multiplier?: number;
  /**
   * full:  uniform in [0, ceiling]       (default; best at spreading load)
   * equal: ceiling/2 + uniform in [0, ceiling/2]   (keeps a guaranteed minimum wait)
   * none:  exactly the ceiling           (for tests and for cases that need predictability)
   */
  jitter?: 'full' | 'equal' | 'none';
}

export function assertValidRetryPolicy(policy: RetryPolicy): void {
  const multiplier = policy.multiplier ?? 2;
  if (!Number.isFinite(policy.baseDelayMs) || policy.baseDelayMs < 0) {
    throw new RangeError('baseDelayMs must be a finite number >= 0');
  }
  if (!Number.isFinite(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    throw new RangeError('maxDelayMs must be a finite number >= baseDelayMs');
  }
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw new RangeError('multiplier must be a finite number >= 1');
  }
}

/** The un-jittered delay before retry number `retryNumber` (0 is the first retry), capped at maxDelayMs. */
export function backoffCeilingMs(policy: RetryPolicy, retryNumber: number): number {
  assertValidRetryPolicy(policy);
  if (!Number.isInteger(retryNumber) || retryNumber < 0) throw new RangeError('retryNumber must be an integer >= 0');
  const raw = policy.baseDelayMs * (policy.multiplier ?? 2) ** retryNumber;
  return Math.min(policy.maxDelayMs, raw); // Infinity (huge exponents) is clamped here too
}

export interface RetryDelayOptions {
  /** Defaults to Math.random. Must return a number in [0, 1). */
  random?: () => number;
  /**
   * A minimum wait demanded by the other side (an HTTP Retry-After). It is honoured, but never beyond
   * the policy's own maximum: a server cannot park us for a day.
   */
  minDelayMs?: number;
}

/** How long to wait, in whole milliseconds, before retry number `retryNumber` (0 is the first retry). */
export function retryDelayMs(policy: RetryPolicy, retryNumber: number, options: RetryDelayOptions = {}): number {
  const ceiling = backoffCeilingMs(policy, retryNumber);
  const random = options.random ?? Math.random;
  const draw = random();
  if (!(draw >= 0 && draw < 1)) throw new RangeError('random() must return a number in [0, 1)');

  let delay: number;
  switch (policy.jitter ?? 'full') {
    case 'none':
      delay = ceiling;
      break;
    case 'equal':
      delay = ceiling / 2 + draw * (ceiling / 2);
      break;
    case 'full':
      delay = draw * ceiling;
      break;
  }
  const floor = Math.min(Math.max(options.minDelayMs ?? 0, 0), policy.maxDelayMs);
  return Math.floor(Math.max(delay, floor));
}

/**
 * Parses an HTTP Retry-After header (delta-seconds or an HTTP date) into milliseconds from `nowMs`.
 * Returns undefined for anything unusable; a bad header must never make a retry crash or wait forever.
 */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number): number | undefined {
  if (header === null || header === undefined) return undefined;
  const value = header.trim();
  if (/^\d{1,9}$/.test(value)) return Number(value) * 1000;
  // Date.parse is lenient enough to read "1.5" or "-5" as dates; a real HTTP date always has letters.
  if (!/[A-Za-z]/.test(value)) return undefined;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - nowMs);
}

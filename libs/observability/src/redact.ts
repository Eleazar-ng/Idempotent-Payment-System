/**
 * What must never reach a log line: secrets, signatures, tokens and card sources. Matching is by key name
 * (so a new field called `webhook_secret` is covered without anyone remembering) and, for free text, by
 * the shapes secrets take in headers.
 */
const SENSITIVE_KEY = /secret|token|authorization|password|signature|api[-_]?key|cookie|source|card/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;
const SIGNATURE_VALUE = /\bv1=[0-9a-f]{16,}/gi;
/** A whole API key (Stage 11). Only the public prefix may be logged; the secret part never. */
const API_KEY = /\bpk_([0-9a-f]{12})_[A-Za-z0-9_-]{20,}/g;

export const REDACTED = '[redacted]';

export function scrubText(text: string): string {
  return text.replace(BEARER, `Bearer ${REDACTED}`).replace(SIGNATURE_VALUE, `v1=${REDACTED}`).replace(API_KEY, `pk_$1_${REDACTED}`);
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[truncated]';
  if (value instanceof Error) return { name: value.name, message: scrubText(value.message), stack: value.stack ? scrubText(value.stack) : undefined };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

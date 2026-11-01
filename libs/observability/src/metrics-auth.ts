import { timingSafeEqual } from 'node:crypto';

/**
 * Whether a request may read /metrics. With no token configured the endpoint is open (fine on a private
 * network or a separate port); with one it needs `Authorization: Bearer <token>`, compared in constant
 * time so the token cannot be guessed a character at a time.
 */
export function metricsRequestAllowed(authorization: string | undefined, token: string | undefined): boolean {
  if (!token) return true;
  const match = /^Bearer (.+)$/.exec(authorization ?? '');
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

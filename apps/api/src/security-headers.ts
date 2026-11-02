import type { NextFunction, Request, Response } from 'express';

/**
 * Headers every response carries (Stage 11).
 *
 *   X-Powered-By removed        no need to tell strangers which framework answers
 *   X-Content-Type-Options      a JSON body is never sniffed into something executable
 *   Cache-Control: no-store     payment details and balances must not sit in a shared cache or a browser history
 *
 * HSTS is not set here: it only means something over https, and TLS ends at the proxy or load balancer in front of this
 * process, so that is where it belongs.
 */
export function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

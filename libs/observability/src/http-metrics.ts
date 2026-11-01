import type { NextFunction, Request, Response } from 'express';
import type { AppMetrics } from './metrics';

/**
 * The label is the route PATTERN (`/v1/payments/:id`), never the URL: one series per payment id would
 * be unbounded. A request that matched no route is `unmatched`, so scanners probing random paths cannot
 * create series either.
 */
export function routeLabel(req: Pick<Request, 'baseUrl' | 'route'>): string {
  const path = req.route?.path;
  return typeof path === 'string' ? `${req.baseUrl ?? ''}${path}` : 'unmatched';
}

export function httpMetricsMiddleware(metrics: AppMetrics) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const route = routeLabel(req);
      const method = req.method;
      metrics.httpRequests.inc({ method, route, status_class: `${Math.floor(res.statusCode / 100)}xx` });
      metrics.httpDuration.observe({ method, route }, Number(process.hrtime.bigint() - started) / 1e9);
    });
    next();
  };
}

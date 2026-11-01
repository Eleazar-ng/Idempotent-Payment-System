import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The id of the request being handled, from anywhere below it (logs pick it up without being passed it). */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function runWithRequestId<T>(requestId: string, work: () => T): T {
  return storage.run({ requestId }, work);
}

/**
 * A caller's id is kept only if it is short and plain: it ends up in every log line, so a hostile one
 * (newlines, a megabyte of text) must never get in. Anything else is replaced, not trimmed.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export function requestIdFrom(header: unknown): string {
  return typeof header === 'string' && SAFE_REQUEST_ID.test(header) ? header : randomUUID();
}

/** Gives every request an id, echoes it in the response, and makes it available to logs. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = requestIdFrom(req.headers[REQUEST_ID_HEADER]);
  res.setHeader('X-Request-Id', requestId);
  runWithRequestId(requestId, next);
}

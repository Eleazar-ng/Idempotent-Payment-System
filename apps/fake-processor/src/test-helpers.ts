import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '@app/config';

export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';

export function fakeConfig(overrides: Record<string, unknown> = {}): ConfigService<Env, true> {
  const values: Record<string, unknown> = { PROCESSOR_WEBHOOK_SECRET: WEBHOOK_SECRET, ...overrides };
  return { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
}

export const uid = () => randomBytes(4).toString('hex');

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A tiny HTTP server standing in for OUR webhook endpoint. `respondWith` decides each reply. */
export async function startReceiver(respondWith: (n: number) => number = () => 200) {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.statusCode = respondWith(received.length);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/webhooks`,
    received,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

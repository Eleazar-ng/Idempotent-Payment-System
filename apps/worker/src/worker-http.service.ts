import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { DB } from '@app/db';
import type { Database } from '@app/db';
import { metricsRequestAllowed, METRICS } from '@app/observability';
import type { AppMetrics } from '@app/observability';
import { refreshStateGauges } from './state-gauges';

export const WORKER_HTTP_OPTIONS = Symbol('WORKER_HTTP_OPTIONS');

export interface WorkerHttpOptions {
  /** 0 picks a free port (tests). */
  port: number;
  metricsToken?: string;
  readinessTimeoutMs: number;
}

/**
 * The worker has no API, but it still has to be scraped and probed: /metrics (with the database state
 * gauges), /health (alive) and /health/ready (can reach the database). Plain node:http, three routes,
 * nothing else listens.
 */
@Injectable()
export class WorkerHttpService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerHttpService.name);
  private server: Server | undefined;

  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(METRICS) private readonly metrics: AppMetrics,
    @Inject(WORKER_HTTP_OPTIONS) private readonly options: WorkerHttpOptions,
  ) {}

  /** The port actually bound (useful when configured as 0). */
  get port(): number {
    const address = this.server?.address();
    return typeof address === 'object' && address ? address.port : this.options.port;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req.method ?? 'GET', (req.url ?? '/').split('?')[0], req.headers.authorization, res).catch((error: unknown) => {
        this.logger.error(`worker http error: ${String(error)}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.options.port, () => resolve());
    });
    this.logger.log(`worker http listening on :${this.port}`);
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(method: string, path: string, authorization: string | undefined, res: import('node:http').ServerResponse): Promise<void> {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (method !== 'GET') return json(405, { error: { code: 'method_not_allowed' } });

    if (path === '/health') return json(200, { status: 'ok' });

    if (path === '/health/ready') {
      try {
        await Promise.race([
          sql`select 1`.execute(this.db),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), this.options.readinessTimeoutMs).unref()),
        ]);
        return json(200, { status: 'ready' });
      } catch {
        return json(503, { status: 'unavailable', failed: ['database'] });
      }
    }

    if (path === '/metrics') {
      if (!metricsRequestAllowed(authorization, this.options.metricsToken)) {
        return json(401, { error: { code: 'unauthorized', message: 'Missing or wrong metrics token.' } });
      }
      await refreshStateGauges(this.db, this.metrics);
      res.writeHead(200, { 'content-type': this.metrics.registry.contentType }).end(await this.metrics.registry.metrics());
      return;
    }
    return json(404, { error: { code: 'not_found' } });
  }
}

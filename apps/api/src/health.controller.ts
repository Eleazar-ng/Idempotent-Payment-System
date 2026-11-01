import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { DB } from '@app/db';
import type { Database } from '@app/db';

export const READINESS_TIMEOUT_MS = Symbol('READINESS_TIMEOUT_MS');

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(READINESS_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {}

  /** Liveness: the process is up and serving. Deliberately does not touch the database: a database outage must not make an orchestrator restart healthy API processes. */
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: can this instance do its job right now? It asks the database a trivial question with a deadline.
   * 503 takes the instance out of the load balancer without killing it. The body says which check failed, never why
   * (error text can carry hostnames and credentials).
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response): Promise<{ status: 'ready' | 'unavailable'; failed?: string[] }> {
    try {
      await Promise.race([
        sql`select 1`.execute(this.db),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), this.timeoutMs).unref()),
      ]);
      return { status: 'ready' };
    } catch {
      res.status(503);
      return { status: 'unavailable', failed: ['database'] };
    }
  }
}

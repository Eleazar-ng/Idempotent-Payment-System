import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  /** Liveness only. A readiness check that also pings Postgres arrives with Stage 1. */
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

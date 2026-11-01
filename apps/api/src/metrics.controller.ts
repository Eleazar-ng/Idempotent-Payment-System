import { Controller, Get, Headers, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { metricsRequestAllowed, METRICS } from '@app/observability';
import type { AppMetrics } from '@app/observability';

export const METRICS_OPTIONS = Symbol('METRICS_OPTIONS');

export interface MetricsOptions {
  /** If set, /metrics requires `Authorization: Bearer <token>`. */
  token?: string;
}

@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(METRICS) private readonly metrics: AppMetrics,
    @Inject(METRICS_OPTIONS) private readonly options: MetricsOptions,
  ) {}

  @Get()
  async scrape(@Headers('authorization') authorization: string | undefined, @Res() res: Response): Promise<void> {
    if (!metricsRequestAllowed(authorization, this.options.token)) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'Missing or wrong metrics token.' } });
      return;
    }
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}

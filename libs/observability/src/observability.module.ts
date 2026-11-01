import { Global,Module } from '@nestjs/common';
import { createMetrics } from './metrics';
import type { AppMetrics } from './metrics';
import { ObservabilityService } from './observability.service';

export const METRICS = Symbol('METRICS');

/** One metrics registry per process, available everywhere by injecting `METRICS`. */
@Global()
@Module({
  providers: [
    ObservabilityService,
    { provide: METRICS, useFactory: (): AppMetrics => createMetrics({ defaultMetrics: true }) }
  ],
  exports: [ObservabilityService, METRICS],
})
export class ObservabilityModule {}

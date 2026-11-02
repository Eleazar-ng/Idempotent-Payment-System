import { Module } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from '@app/config';
import type { Env } from '@app/config';
import { DbModule } from '@app/db';
import { httpMetricsMiddleware, METRICS, ObservabilityModule, requestIdMiddleware } from '@app/observability';
import type { AppMetrics } from '@app/observability';
import { Inject } from '@nestjs/common';
import { AuthService } from './auth.service';
import { WebhookEndpointController } from './webhook-endpoint.controller';
import { WEBHOOK_URL_OPTIONS, WebhookEndpointService } from './webhook-endpoint.service';
import type { WebhookUrlOptions } from './webhook-endpoint.service';
import { securityHeadersMiddleware } from './security-headers';
import { HealthController, READINESS_TIMEOUT_MS} from './health.controller';
import { METRICS_OPTIONS, MetricsController } from './metrics.controller';
import type { MetricsOptions } from './metrics.controller';
import { BalanceController, PaymentsController } from './payments.controller';
import { PAYMENT_FLOW_OPTIONS, PaymentsService } from './payments.service';
import type { PaymentFlowOptions } from './payments.service';
import { WebhooksController } from './webhooks.controller';
import { WEBHOOK_OPTIONS, WebhooksService } from './webhooks.service';
import type { WebhookOptions } from './webhooks.service';
import { PROCESSOR_CLIENT_OPTIONS, ProcessorClient } from './processor.client';
import type { ProcessorClientOptions } from './processor.client';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';

@Module({
  imports: [AppConfigModule, DbModule, ObservabilityModule],
  controllers: [ApiController,MetricsController, HealthController, PaymentsController, BalanceController, WebhookEndpointController, WebhooksController],
  providers: [
    ApiService,
    {
      provide: PROCESSOR_CLIENT_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): ProcessorClientOptions => ({
        baseUrl: config.get('PROCESSOR_BASE_URL', { infer: true }),
        timeoutMs: config.get('PROCESSOR_TIMEOUT_MS', { infer: true }),
      }),
    },
    {
      provide: PAYMENT_FLOW_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): PaymentFlowOptions => ({
        callRetries: config.get('PROCESSOR_CALL_RETRIES', { infer: true }),
        retryDelayMs: config.get('PROCESSOR_RETRY_DELAY_MS', { infer: true }),
        retryMaxDelayMs: config.get('PROCESSOR_RETRY_MAX_DELAY_MS', { infer: true }),
        feeBps: config.get('PLATFORM_FEE_BPS', { infer: true }),
      }),
    },
    {
      provide: WEBHOOK_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): WebhookOptions => ({
        // During a rotation both secrets verify; signatures are checked against each in constant time.
        secret: [config.get('PROCESSOR_WEBHOOK_SECRET', { infer: true }), config.get('PROCESSOR_WEBHOOK_SECRET_PREVIOUS', { infer: true })].filter(
          (s): s is string => typeof s === 'string',
        ),
        feeBps: config.get('PLATFORM_FEE_BPS', { infer: true }),
      }),
    },
    {
      provide: METRICS_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): MetricsOptions => ({ token: config.get('METRICS_TOKEN', { infer: true }) }),
    },
    {
      provide: READINESS_TIMEOUT_MS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): number => config.get('READINESS_TIMEOUT_MS', { infer: true }),
    },
    AuthService,
    {
      provide: WEBHOOK_URL_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): WebhookUrlOptions => ({
        policy: {
          allowHttp: config.get('WEBHOOK_ALLOW_HTTP', { infer: true }),
          allowPrivateNetworks: config.get('WEBHOOK_ALLOW_PRIVATE_NETWORKS', { infer: true }),
        },
      }),
    },
    WebhookEndpointService,
    ProcessorClient,
    WebhooksService,
    PaymentsService,
  ],
})
export class ApiModule implements NestModule {
  constructor(@Inject(METRICS) private readonly metrics: AppMetrics) {}

  /** Every request gets an id (echoed back, present on its log lines) and is counted and timed by route pattern. */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(securityHeadersMiddleware, requestIdMiddleware, httpMetricsMiddleware(this.metrics)).forRoutes('*');
  }
}

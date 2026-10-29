import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfigModule } from '@app/config';
import type { Env } from '@app/config';
import { DbModule } from '@app/db';
import { HealthController } from './health.controller';
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
  imports: [AppConfigModule, DbModule],
  controllers: [ApiController, HealthController, PaymentsController, BalanceController, WebhooksController],
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
        secret: config.get('PROCESSOR_WEBHOOK_SECRET', { infer: true }),
        feeBps: config.get('PLATFORM_FEE_BPS', { infer: true }),
      }),
    },
    ProcessorClient,
    WebhooksService,
    PaymentsService,
  ],
})
export class ApiModule {}

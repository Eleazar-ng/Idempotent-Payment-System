import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import type { ZodType } from 'zod';
import { ProcessorService } from './processor.service';
import { advanceClockSchema, flushSchema, resolveSchema, ruleInputSchema, webhookConfigSchema } from './schemas';
import { WebhookService } from './webhook.service';

function parse<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new BadRequestException({
      error: {
        type: 'invalid_request_error',
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  return result.data;
}

/**
 * The remote control. Not part of any real processor's API: it exists so tests and demos can say
 * "the next charge for this order times out after the money moved", on demand and repeatably.
 */
@Controller('_control')
export class ControlController {
  constructor(
    private readonly processor: ProcessorService,
    private readonly webhooks: WebhookService,
  ) {}

  @Post('rules')
  addRule(@Body() body: unknown) {
    return this.processor.addRule(parse(ruleInputSchema, body));
  }

  @Get('rules')
  listRules() {
    return { data: this.processor.listRules() };
  }

  @Delete('rules')
  @HttpCode(204)
  clearRules(): void {
    this.processor.clearRules();
  }

  @Post('charges/:id/resolve')
  @HttpCode(200)
  resolve(@Param('id') id: string, @Body() body: unknown) {
    const { outcome, failureCode } = parse(resolveSchema, body);
    const result = this.processor.resolveCharge(id, outcome, failureCode);
    if (result.result === 'not_found') throw new NotFoundException({ error: { code: 'resource_missing' } });
    if (result.result === 'not_resolvable') {
      throw new ConflictException({
        error: { code: 'charge_not_resolvable', message: `charge is already ${result.status}` },
      });
    }
    return result.charge;
  }

  @Put('webhook')
  configureWebhook(@Body() body: unknown) {
    return this.webhooks.configure(parse(webhookConfigSchema, body));
  }

  @Get('webhook')
  getWebhook() {
    return this.webhooks.getSettings();
  }

  @Post('webhook/flush')
  @HttpCode(200)
  async flush(@Body() body: unknown) {
    const { order } = parse(flushSchema, body);
    return { delivered: await this.webhooks.flush(order) };
  }

  @Get('events')
  async events() {
    await this.webhooks.idle();
    return { data: this.webhooks.listEvents() };
  }

  @Post('events/:id/redeliver')
  @HttpCode(200)
  async redeliver(@Param('id') id: string) {
    if (!(await this.webhooks.redeliver(id))) throw new NotFoundException({ error: { code: 'resource_missing' } });
    return { redelivered: id };
  }

  @Post('clock/advance')
  @HttpCode(200)
  advance(@Body() body: unknown) {
    this.processor.advanceClock(parse(advanceClockSchema, body).ms);
    return { now: new Date(this.processor.now()).toISOString() };
  }

  @Get('stats')
  stats() {
    return this.processor.stats();
  }

  @Post('reset')
  @HttpCode(204)
  reset(): void {
    this.processor.reset();
  }
}

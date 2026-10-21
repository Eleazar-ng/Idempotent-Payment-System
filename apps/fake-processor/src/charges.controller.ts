import { Body, Controller, Get, Headers, HttpCode, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ProcessorService } from './processor.service';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The processor's public API, the one our payment code (Stage 5) calls. */
@Controller('v1/charges')
export class ChargesController {
  constructor(private readonly processor: ProcessorService) {}

  @Post()
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const exchange = await this.processor.createCharge(idempotencyKey, body);
    if (exchange.responseDelayMs > 0) await sleep(exchange.responseDelayMs);

    if (exchange.action === 'drop') {
      // No response at all, not even an error: the caller sees a reset connection.
      res.socket?.destroy();
      return;
    }
    res.status(exchange.status).set(exchange.headers).json(exchange.body);
  }

  @Get(':id')
  retrieve(@Param('id') id: string) {
    const charge = this.processor.getCharge(id);
    if (!charge) throw new NotFoundException({ error: { type: 'invalid_request_error', code: 'resource_missing' } });
    return charge;
  }

  /** Lookup by `metadata.reference`: how reconciliation finds a charge whose id we never received. */
  @Get()
  @HttpCode(200)
  list(@Query('reference') reference?: string) {
    return { object: 'list', data: this.processor.listCharges({ reference }) };
  }
}

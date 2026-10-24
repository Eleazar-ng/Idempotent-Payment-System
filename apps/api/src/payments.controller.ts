import { Body, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PaymentsService } from './payments.service';
import type { HttpResult } from './payment-http';

function send(res: Response, result: HttpResult): unknown {
  res.status(result.status);
  for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
  return result.body;
}

@Controller('v1/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  async create(
    @Headers('x-merchant-id') merchantId: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return send(res, await this.payments.createPayment({ merchantId, idempotencyKey, body }));
  }

  @Get(':id')
  async retrieve(
    @Headers('x-merchant-id') merchantId: string | undefined,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return send(res, await this.payments.getPayment(merchantId, id));
  }
}

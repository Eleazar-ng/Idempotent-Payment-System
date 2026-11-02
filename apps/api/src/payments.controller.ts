import { Body, Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PaymentsService } from './payments.service';
import { sendResult as send } from './payment-http';


@Controller('v1/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  async create(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return send(res, await this.payments.createPayment({ authorization, idempotencyKey, body }));
  }

  @Get(':id')
  async retrieve(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return send(res, await this.payments.getPayment(authorization, id));
  }
}

@Controller('v1/balance')
export class BalanceController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  async retrieve(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return send(res, await this.payments.getBalance(authorization));
  }
}

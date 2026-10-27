import { Controller, Headers, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { WEBHOOK_SIGNATURE_HEADER } from '@app/payments-core';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('processor')
  @HttpCode(200)
  async processor(
    @Req() req: RawBodyRequest<Request>,
    @Headers(WEBHOOK_SIGNATURE_HEADER) signature: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    const result = await this.webhooks.receive({ rawBody: req.rawBody, signature });
    res.status(result.status);
    return result.body;
  }
}

import { Body, Controller, Delete, Get, Headers, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { sendResult } from './payment-http';
import { WebhookEndpointService } from './webhook-endpoint.service';

@Controller('v1/webhook-endpoint')
export class WebhookEndpointController {
  constructor(private readonly endpoints: WebhookEndpointService) {}

  @Get()
  async retrieve(@Headers('authorization') authorization: string | undefined, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    return sendResult(res, await this.endpoints.get(authorization));
  }

  @Put()
  async set(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<unknown> {
    return sendResult(res, await this.endpoints.set(authorization, body));
  }

  @Post('secret')
  async rotate(@Headers('authorization') authorization: string | undefined, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    return sendResult(res, await this.endpoints.rotateSecret(authorization));
  }

  @Delete()
  async remove(@Headers('authorization') authorization: string | undefined, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    return sendResult(res, await this.endpoints.remove(authorization));
  }
}

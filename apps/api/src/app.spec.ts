import { Body, Controller, Module, Post, RawBodyRequest, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createApp, NEST_APP_OPTIONS } from './bootstrap';

describe('api app', () => {
  // Env vars come from jest.setup-env.js, which runs before this file is loaded.
  it('boots with validated config and answers the liveness probe', async () => {
    const app = await createApp();
    await app.init();

    await request(app.getHttpServer()).get('/health').expect(200).expect({ status: 'ok' });

    await app.close();
  });
});

describe('NEST_APP_OPTIONS (raw body for webhook signatures)', () => {
  @Controller('echo')
  class EchoController {
    @Post()
    echo(@Req() req: RawBodyRequest<Request>, @Body() body: unknown) {
      return { raw: req.rawBody?.toString('utf8'), parsed: body };
    }
  }

  @Module({ controllers: [EchoController] })
  class EchoModule {}

  it('keeps the exact request bytes, including whitespace and key order', async () => {
    const app = await NestFactory.create<NestExpressApplication>(EchoModule, {
      ...NEST_APP_OPTIONS,
      logger: false,
    });
    await app.init();

    // Deliberately odd spacing: a re-serialized body would not match this byte for byte.
    const payload = '{ "b":2,   "a":1 }';
    const res = await request(app.getHttpServer())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send(payload)
      .expect(201);

    expect(res.body.raw).toBe(payload);
    expect(res.body.parsed).toEqual({ a: 1, b: 2 });

    await app.close();
  });
});

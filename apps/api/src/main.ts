import { ConfigService } from '@nestjs/config';
import type { Env } from '@app/config';
import { createApp } from './bootstrap';

async function main(): Promise<void> {
  const app = await createApp();
  const port = app.get<ConfigService<Env, true>>(ConfigService).get('API_PORT');
  await app.listen(port);
  console.log(`api listening on :${port}`);
}

void main();

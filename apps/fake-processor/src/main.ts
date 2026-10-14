import { NestFactory } from '@nestjs/core';
import { FakeProcessorModule } from './fake-processor.module';

async function bootstrap() {
  const app = await NestFactory.create(FakeProcessorModule);
  await app.listen(process.env.port ?? 3000);
}
bootstrap();

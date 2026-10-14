import { Module } from '@nestjs/common';
import { AppConfigModule } from '@app/config';
import { FakeProcessorController } from './fake-processor.controller';
import { FakeProcessorService } from './fake-processor.service';
import { HealthController } from './health.controller';

@Module({
  imports: [AppConfigModule],
  controllers: [FakeProcessorController, HealthController],
  providers: [FakeProcessorService],
})
export class FakeProcessorModule {}

import { Module } from '@nestjs/common';
import { AppConfigModule } from '@app/config';
import { FakeProcessorController } from './fake-processor.controller';
import { FakeProcessorService } from './fake-processor.service';
import { HealthController } from './health.controller';
import { ChargesController } from './charges.controller';
import { ControlController } from './control.controller';
import { ProcessorService } from './processor.service';
import { WebhookService } from './webhook.service';

@Module({
  imports: [AppConfigModule],
  controllers: [FakeProcessorController, HealthController, ChargesController, ControlController],
  providers: [FakeProcessorService, ProcessorService, WebhookService],
})
export class FakeProcessorModule {}

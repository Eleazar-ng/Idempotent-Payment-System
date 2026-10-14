import { Module } from '@nestjs/common';
import { FakeProcessorController } from './fake-processor.controller';
import { FakeProcessorService } from './fake-processor.service';

@Module({
  imports: [],
  controllers: [FakeProcessorController],
  providers: [FakeProcessorService],
})
export class FakeProcessorModule {}

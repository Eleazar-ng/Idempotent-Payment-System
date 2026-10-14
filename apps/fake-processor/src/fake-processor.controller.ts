import { Controller, Get } from '@nestjs/common';
import { FakeProcessorService } from './fake-processor.service';

@Controller()
export class FakeProcessorController {
  constructor(private readonly fakeProcessorService: FakeProcessorService) {}

  @Get()
  getHello(): string {
    return this.fakeProcessorService.getHello();
  }
}

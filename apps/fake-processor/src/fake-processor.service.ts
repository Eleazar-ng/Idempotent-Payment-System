import { Injectable } from '@nestjs/common';

@Injectable()
export class FakeProcessorService {
  getHello(): string {
    return 'Hello World!';
  }
}

import { Test, TestingModule } from '@nestjs/testing';
import { FakeProcessorController } from './fake-processor.controller';
import { FakeProcessorService } from './fake-processor.service';

describe('FakeProcessorController', () => {
  let fakeProcessorController: FakeProcessorController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [FakeProcessorController],
      providers: [FakeProcessorService],
    }).compile();

    fakeProcessorController = app.get<FakeProcessorController>(FakeProcessorController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(fakeProcessorController.getHello()).toBe('Hello World!');
    });
  });
});

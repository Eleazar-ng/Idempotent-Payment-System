import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsCoreService } from './payments-core.service';

describe('PaymentsCoreService', () => {
  let service: PaymentsCoreService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PaymentsCoreService],
    }).compile();

    service = module.get<PaymentsCoreService>(PaymentsCoreService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

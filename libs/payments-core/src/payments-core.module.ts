import { Module } from '@nestjs/common';
import { PaymentsCoreService } from './payments-core.service';

@Module({
  providers: [PaymentsCoreService],
  exports: [PaymentsCoreService],
})
export class PaymentsCoreModule {}

import { Module } from '@nestjs/common';
import { AppConfigModule } from '@app/config';
import { DbModule } from '@app/db';
import { WorkerController } from './worker.controller';
import { WorkerService } from './worker.service';

@Module({
  imports: [AppConfigModule, DbModule],
  controllers: [WorkerController],
  providers: [WorkerService],
})
export class WorkerModule {}

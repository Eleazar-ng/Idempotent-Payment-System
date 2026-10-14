import { Module } from '@nestjs/common';
import { AppConfigModule } from '@app/config';
import { DbModule } from '@app/db';
import { HealthController } from './health.controller';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';

@Module({
  imports: [AppConfigModule, DbModule],
  controllers: [ApiController, HealthController],
  providers: [ApiService],
})
export class ApiModule {}

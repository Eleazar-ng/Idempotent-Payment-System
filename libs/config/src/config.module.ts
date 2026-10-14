import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { loadEnv } from './env';
import { ConfigService } from './config.service';

/**
 * Global, validated configuration. Inject `ConfigService<Env, true>` anywhere;
 * `config.get('DATABASE_URL')` is then fully typed and never undefined.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (raw) => loadEnv(raw),
    }),
  ],
  providers: [ConfigService],
  exports: [ConfigService],
})
export class AppConfigModule {}

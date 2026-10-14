import { DbService } from './db.service';
import { Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Kysely } from 'kysely';
import type { Env } from '../../config/src';
import { createDb } from './create-db';
import type { Database } from './database.types';

/** Injection token for the shared Kysely instance: `@Inject(DB) private db: Kysely<Database>`. */
export const DB = Symbol('DB');

@Module({
  providers: [
    {
      provide: DB,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => createDb(config.get('DATABASE_URL')),
    },
    DbService,
    // Turn the lifecycle provider into a custom provider mapping instead of an Injectable class!
    {
      provide: 'DB_LIFECYCLE',
      inject: [DB],
      useFactory: (db: Kysely<Database>) => {
        return {
          async onApplicationShutdown() {
            await db.destroy();
          }
        };
      }
    }
  ],
  exports: [DB, DbService],
})
export class DbModule {}

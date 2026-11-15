import { Inject, Injectable, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { createDatabase } from './database.js';
import type { Database } from './database.js';
import type { DbConfig } from './pools.js';

export const DATABASE = Symbol('DATABASE');

/** Opens the pool's first connection when the application initialises and closes the pool on shutdown. */
@Injectable()
export class DatabaseLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(DATABASE) private readonly database: Pick<Database, 'checkReady' | 'close'>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.database.checkReady();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.database.close();
  }
}

@Module({})
export class DatabaseModule {
  static forRoot(config: DbConfig): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        { provide: DATABASE, useFactory: () => createDatabase(config) },
        DatabaseLifecycle,
      ],
      exports: [DATABASE],
    };
  }
}

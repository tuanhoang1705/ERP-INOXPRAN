import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Db, MongoClient } from 'mongodb';
import { MONGO_CLIENT, MONGO_DATABASE } from './tokens';

@Injectable()
class MongoLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MONGO_CLIENT) private readonly client: MongoClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: MONGO_CLIENT,
      inject: [ConfigService],
      useFactory: async (config: ConfigService): Promise<MongoClient> => {
        const client = new MongoClient(config.getOrThrow<string>('MONGODB_URI'), {
          retryWrites: true,
          readConcern: { level: 'majority' },
          writeConcern: { w: 'majority', journal: true },
          appName: 'inoxpran-erp-api',
        });
        await client.connect();
        return client;
      },
    },
    {
      provide: MONGO_DATABASE,
      inject: [MONGO_CLIENT, ConfigService],
      useFactory: (client: MongoClient, config: ConfigService): Db =>
        client.db(config.getOrThrow<string>('MONGODB_DATABASE')),
    },
    MongoLifecycle,
  ],
  exports: [MONGO_CLIENT, MONGO_DATABASE],
})
export class MongoModule {}

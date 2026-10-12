import { Inject, Injectable } from '@nestjs/common';
import { type ClientSession, type Db, ObjectId } from 'mongodb';
import { MONGO_DATABASE } from './tokens';

export interface AuditInput {
  actorId: string;
  actorEmail: string;
  action: string;
  entityType: string;
  entityId: string;
  correlationId: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  async record(input: AuditInput, session?: ClientSession): Promise<void> {
    await this.db.collection('audit_events').insertOne(
      {
        _id: new ObjectId(),
        ...input,
        occurredAt: new Date(),
      },
      session ? { session } : {},
    );
  }
}

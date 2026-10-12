import { Inject, Injectable } from '@nestjs/common';
import type { ClientSession, Db } from 'mongodb';
import { ObjectId } from 'mongodb';
import { MONGO_DATABASE } from './tokens';

export interface OutboxEventInput {
  eventType: 'APPROVAL_REQUESTED' | 'NOTIFICATION_REQUESTED';
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class OutboxService {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  async enqueue(input: OutboxEventInput, session?: ClientSession): Promise<ObjectId> {
    const eventId = new ObjectId();
    const now = new Date();
    await this.db.collection('outbox_events').insertOne(
      {
        _id: eventId,
        eventType: input.eventType,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        payload: input.payload,
        status: 'PENDING',
        relayAttempts: 0,
        availableAt: now,
        occurredAt: now,
      },
      session ? { session } : {},
    );
    return eventId;
  }
}

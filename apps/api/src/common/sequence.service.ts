import { Inject, Injectable } from '@nestjs/common';
import { type ClientSession, type Db } from 'mongodb';
import { vnParts } from './domain';
import { MONGO_DATABASE } from './tokens';

interface CounterDocument {
  _id: string;
  value: number;
  createdAt: Date;
}

@Injectable()
export class SequenceService {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  /**
   * Số chứng từ theo tháng. style 'dash': DH2610-0001; style 'compact': BH2026100001 / SWK2026090103
   * (đúng định dạng phiếu xuất kho bán hàng của INOXPRAN).
   */
  async next(prefix: string, session?: ClientSession, width = 5, at = new Date(), style: 'dash' | 'compact' = 'dash'): Promise<string> {
    const now = new Date();
    const { year, month } = vnParts(at);
    const period = `${String(year).slice(-2)}${String(month).padStart(2, '0')}`;
    const key = `${prefix}:${period}`;
    const counter = await this.db.collection<CounterDocument>('counters').findOneAndUpdate(
      { _id: key },
      { $inc: { value: 1 }, $setOnInsert: { createdAt: now } },
      { upsert: true, returnDocument: 'after', ...(session ? { session } : {}) },
    );
    const sequence = String(counter?.value ?? 1).padStart(width, '0');
    return style === 'compact' ? `${prefix}${year}${String(month).padStart(2, '0')}${sequence}` : `${prefix}${period}-${sequence}`;
  }
}

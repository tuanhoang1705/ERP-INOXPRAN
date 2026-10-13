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
  /** Đẩy bộ đếm của tháng lên ít nhất `value` (số đã dùng lớn nhất) để số tự sinh kế tiếp nối tiếp sau đó. */
  async ensureAtLeast(prefix: string, at: Date, value: number, session?: ClientSession): Promise<void> {
    if (value <= 0) return;
    const { year, month } = vnParts(at);
    const key = `${prefix}:${String(year).slice(-2)}${String(month).padStart(2, '0')}`;
    await this.db.collection<CounterDocument>('counters').updateOne(
      { _id: key },
      { $max: { value }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true, ...(session ? { session } : {}) },
    );
  }

  /**
   * Ghi nhận một số vừa dùng trong tháng: số lớn nhất (`value`) và số đầu tiên (`floor`, để tháng bắt đầu từ đơn 104 thì
   * khi hủy hết vẫn quay lại 104). Ghi trong giao dịch → hai người lập phiếu cùng lúc xung đột ghi và được chạy lại.
   */
  async track(prefix: string, at: Date, value: number, session?: ClientSession): Promise<void> {
    const { year, month } = vnParts(at);
    const key = `${prefix}:${String(year).slice(-2)}${String(month).padStart(2, '0')}`;
    await this.db.collection<CounterDocument & { floor?: number }>('counters').updateOne(
      { _id: key },
      { $max: { value }, $min: { floor: value }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true, ...(session ? { session } : {}) },
    );
  }

  /** Số đầu tiên đã ghi nhận của tháng (null nếu chưa có). */
  async floor(prefix: string, at: Date, session?: ClientSession): Promise<number | null> {
    const { year, month } = vnParts(at);
    const key = `${prefix}:${String(year).slice(-2)}${String(month).padStart(2, '0')}`;
    const row = await this.db.collection<CounterDocument & { floor?: number }>('counters').findOne({ _id: key }, session ? { session } : {});
    return typeof row?.floor === 'number' ? row.floor : null;
  }

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

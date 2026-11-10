import { Inject, Injectable } from '@nestjs/common';
import { type ClientSession, type Db } from 'mongodb';
import { highestActiveSequence, NUMBERED_DOCUMENTS, releaseDocumentNumber } from './document-numbers';
import { vnParts } from './domain';
import { MONGO_DATABASE } from './tokens';

interface CounterDocument {
  _id: string;
  value: number;
  createdAt: Date;
}

/**
 * Số chứng từ theo cách đánh số phiếu BH (NUM-01): tiền tố + năm + tháng của ngày chứng từ + 4 số đếm tiếp cả năm
 * (PAY2026110301, NK2026110061). Năm sau đánh lại từ 0001; quá 9999 trong năm thì thành 5 số.
 */
export function documentCode(prefix: string, at: Date, sequence: number): string {
  const { year, month } = vnParts(at);
  return `${prefix}${year}${String(month).padStart(2, '0')}${String(sequence).padStart(4, '0')}`;
}

@Injectable()
export class SequenceService {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

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

  /**
   * Ghi nhận số vừa cấp theo số lớn nhất đang dùng (phiếu trả hàng NK / XT — số của phiếu hủy được dùng lại như phiếu BH):
   * luôn ghi vào bộ đếm năm trong giao dịch → hai người lập cùng lúc xung đột ghi và được chạy lại, không trùng số.
   */
  async claim(prefix: string, at: Date, value: number, session: ClientSession): Promise<void> {
    const { year } = vnParts(at);
    await this.db.collection<CounterDocument & { claims?: number }>('counters').updateOne(
      { _id: `${prefix}:Y${year}` },
      { $max: { value }, $inc: { claims: 1 }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true, session },
    );
  }

  /** Số đầu tiên đã ghi nhận trong năm — nhỏ nhất trong các tháng (null nếu chưa có); số phiếu BH đếm tiếp cả năm. */
  async yearFloor(prefix: string, at: Date, session?: ClientSession): Promise<number | null> {
    const { year } = vnParts(at);
    const rows = await this.db.collection<CounterDocument & { floor?: number }>('counters')
      .find({ _id: { $regex: `^${prefix}:${String(year).slice(-2)}\\d{2}$` } }, { projection: { floor: 1 }, ...(session ? { session } : {}) })
      .toArray();
    const floors = rows.map((row) => row.floor).filter((value): value is number => typeof value === 'number');
    return floors.length ? Math.min(...floors) : null;
  }

  /**
   * Số tự sinh kế tiếp của mọi chứng từ ngoài phiếu BH (06/11/2026, người dùng: "tất cả các phiếu theo cách tính số phiếu
   * giống phiếu BH"): tiền tố + năm + tháng của `at` (ngày chứng từ) + 4 số đếm tiếp cả năm, bộ đếm `PREFIX:Y2026`.
   * Trước đây mỗi tháng đánh lại (NK2026110001, PAY2611-00012) → năm đang dở thì đếm tiếp sau số lớn nhất đã cấp trong năm
   * (bộ đếm tháng cũ), như phiếu BH khi đổi cách đếm: BH2026100160 → BH2026110161. Số đã cấp giữ nguyên.
   * Ghi trong giao dịch → hai người lập cùng lúc xung đột ghi và được chạy lại, không trùng số.
   */
  async next(prefix: string, session?: ClientSession, at = new Date()): Promise<string> {
    const { year } = vnParts(at);
    const monthly = await this.db.collection<CounterDocument>('counters')
      .find({ _id: { $regex: `^${prefix}:${String(year).slice(-2)}(0[1-9]|1[0-2])$` } }, { projection: { value: 1 }, ...(session ? { session } : {}) })
      .toArray();
    const base = Math.max(0, ...monthly.map((row) => Number(row.value) || 0));
    if (session && NUMBERED_DOCUMENTS[prefix]) return this.nextActive(prefix, session, at, base);
    const counter = await this.db.collection<CounterDocument>('counters').findOneAndUpdate(
      { _id: `${prefix}:Y${year}` },
      [{ $set: { value: { $add: [{ $max: [{ $ifNull: ['$value', 0] }, base] }, 1] }, createdAt: { $ifNull: ['$createdAt', '$$NOW'] } } }],
      { upsert: true, returnDocument: 'after', ...(session ? { session } : {}) },
    );
    return documentCode(prefix, at, Number(counter?.value ?? base + 1));
  }

  /** Số đã cấp trong giao dịch (chưa ghi phiếu) theo loại + năm — cấp nhiều số liền trong một giao dịch không trùng. */
  private readonly issued = new WeakMap<ClientSession, Map<string, number>>();

  /**
   * NUM-02 (09/11/2026): số lớn nhất đang dùng (chưa hủy) trong năm + 1, như phiếu BH — hủy / xóa phiếu cuối thì phiếu mới lấy lại
   * số đó. Năm đổi cách đếm dở dang: không thấp hơn bộ đếm tháng cũ. Phiếu hủy kiểu cũ (chưa đổi -H) đang giữ số → nhả rồi dùng.
   */
  private async nextActive(prefix: string, session: ClientSession, at: Date, base: number): Promise<string> {
    const source = NUMBERED_DOCUMENTS[prefix]!;
    const { year } = vnParts(at);
    const key = `${prefix}:${year}`;
    const issued = this.issued.get(session) ?? new Map<string, number>();
    this.issued.set(session, issued);
    let sequence = Math.max((await highestActiveSequence(this.db, prefix, year, session)) ?? 0, base, issued.get(key) ?? 0) + 1;
    for (let attempt = 0; attempt < 200; attempt += 1, sequence += 1) {
      const code = documentCode(prefix, at, sequence);
      const holder = await this.db.collection(source.collection).findOne({ code }, { session });
      if (holder && !source.inactive.includes(String(holder.status))) continue;
      if (holder) await releaseDocumentNumber(this.db, prefix, holder, session);
      await this.claim(prefix, at, sequence, session);
      issued.set(key, sequence);
      return code;
    }
    throw new Error(`Không cấp được số ${prefix} mới`);
  }
}

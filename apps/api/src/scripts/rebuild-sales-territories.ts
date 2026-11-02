/**
 * Dựng phân vùng NVKD theo tỉnh từ dữ liệu khách hiện có (PV-01, 30/10/2026) — quản trị hạ tầng chạy một lần sau khi lên bản mới,
 * có bước chạy thử. Trước bản này "khu vực" của khách là mã tỉnh cũ (HAI-DUONG, THAI-BINH…; Hà Nội tách HN-LE bán lẻ / HN-NPP
 * nhà phân phối), trường "tỉnh" ghi tay tên tỉnh mới, NVKD gán từng khách.
 *
 *   1. Gán tỉnh cũ / mới (+ kênh ở Hà Nội) cho từng khách: theo file quyết định → mã khu vực cũ → dò tên tỉnh trong địa chỉ / ô tỉnh.
 *      Mã khu vực và địa chỉ chỉ hai tỉnh mới khác nhau thì không đoán — liệt kê để chốt trong file quyết định.
 *   2. Suy ra phân vùng: (tỉnh cũ, kênh) → NVKD duy nhất của các khách ở đó. Hai NVKD trở lên = xung đột → để trống, liệt kê.
 *   3. Khách chưa có NVKD ở vùng đã giao → gán NVKD của vùng. Khách khác NVKD vùng (sau khi chốt xung đột) → chuyển theo vùng
 *      hoặc giữ làm ngoại lệ theo file quyết định (mặc định: ngoại lệ "dữ liệu cũ — chờ chốt").
 *
 * File quyết định (JSON, biến TERRITORY_DECISIONS_JSON hoặc đường dẫn TERRITORY_DECISIONS_FILE):
 *   { "provinces": { "KH005": "NINH-BINH" },            // tỉnh cũ của khách (thêm "/DISTRIBUTOR" | "/RETAIL" nếu tỉnh tách kênh)
 *     "territories": { "PHU-THO": "NV02", "YEN-BAI": "-" }, // NVKD (mã) phụ trách tỉnh cũ (thêm "/kênh"), "-" = để trống
 *     "customers": { "KH091": "move", "KH097": "keep:Khách online của anh Dũng", "KH076": "rep:GD01:Khách do Giám đốc trực tiếp phụ trách" } }
 *   (move = chuyển về NVKD của vùng; keep = giữ NVKD hiện tại làm ngoại lệ; rep = giao NVKD chỉ định, khác vùng thì ghi ngoại lệ)
 *
 * Chạy thử (mặc định, không ghi gì):  node apps/api/dist/scripts/rebuild-sales-territories.js
 * Chạy thật:  TERRITORY_CONFIRM=DUNG-PHAN-VUNG node apps/api/dist/scripts/rebuild-sales-territories.js --execute
 * Trên máy chủ: cd /opt/inoxpran && docker compose run --rm --no-deps [-e TERRITORY_CONFIRM=…] [-e TERRITORY_DECISIONS_JSON='…'] api node apps/api/dist/scripts/rebuild-sales-territories.js [--execute]
 */
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { customerProvince, matchProvince, newProvince, oldProvince, provinceLabel } from '@inoxpran/contracts';
import { MongoClient, ObjectId, type Document } from 'mongodb';

config({ path: process.env.ENV_FILE ?? resolve(process.cwd(), '../../.env') });

export const TERRITORY_CONFIRM = 'DUNG-PHAN-VUNG';
const LEGACY_REASON = 'Dữ liệu cũ trước phân vùng (30/10/2026) — chờ chốt';

interface Decisions {
  provinces?: Record<string, string>;
  territories?: Record<string, string>;
  customers?: Record<string, string>;
}

function loadDecisions(): Decisions {
  const raw = process.env.TERRITORY_DECISIONS_JSON ?? (process.env.TERRITORY_DECISIONS_FILE ? readFileSync(process.env.TERRITORY_DECISIONS_FILE, 'utf8') : '');
  return raw.trim() ? (JSON.parse(raw) as Decisions) : {};
}

/** "HA-NOI/DISTRIBUTOR" → { province, channel }. */
function splitKey(value: string): { province: string; channel: string } {
  const [province = '', channel = 'ALL'] = value.split('/');
  return { province, channel };
}

const channelText = (channel: string) => (channel === 'DISTRIBUTOR' ? ' – nhà phân phối' : channel === 'RETAIL' ? ' – bán lẻ' : '');

export interface CustomerPlan {
  id: ObjectId;
  code: string;
  name: string;
  oldCode?: string;
  newCode?: string;
  channel?: string;
  source: string;
  problem?: string;
  salesRepId?: ObjectId;
  salesRepName?: string;
}

/** Bước 1: tỉnh cũ / mới / kênh của một khách. */
export function planCustomer(customer: Document, decisions: Decisions): CustomerPlan {
  const base = { id: customer._id as ObjectId, code: String(customer.code), name: String(customer.name), ...(customer.salesRepId ? { salesRepId: customer.salesRepId as ObjectId, salesRepName: String(customer.salesRepName ?? '') } : {}) };
  const decided = decisions.provinces?.[base.code];
  if (decided) {
    const { province, channel } = splitKey(decided);
    const old = oldProvince(province);
    if (!old) return { ...base, source: 'quyết định', problem: `mã tỉnh cũ "${province}" không có` };
    return { ...base, oldCode: old.code, newCode: old.newCode, ...(channel !== 'ALL' ? { channel } : {}), source: 'quyết định' };
  }
  if (customer.provinceOldCode && oldProvince(String(customer.provinceOldCode))) {
    const old = oldProvince(String(customer.provinceOldCode))!;
    return { ...base, oldCode: old.code, newCode: old.newCode, ...(customer.territoryChannel ? { channel: String(customer.territoryChannel) } : {}), source: 'đã có' };
  }
  const region = String(customer.regionCode ?? '');
  const fromRegion = customerProvince({ regionCode: region });
  const fromText = matchProvince(`${String(customer.address ?? '')}, ${String(customer.province ?? '')}`);
  const fromField = matchProvince(String(customer.province ?? ''));
  const textNew = fromField.newCode ?? fromText.newCode;
  const channel = region === 'HN-NPP' ? 'DISTRIBUTOR' : region === 'HN-LE' ? 'RETAIL' : undefined;
  if (fromRegion.oldCode) {
    if (textNew && textNew !== fromRegion.newCode) {
      const guess = fromText.oldCode && fromText.newCode === textNew ? fromText : null;
      if (guess) return { ...base, oldCode: guess.oldCode!, newCode: guess.newCode!, source: `địa chỉ (khu vực cũ ${region} lệch)` };
      return { ...base, newCode: textNew, source: 'địa chỉ', problem: `khu vực cũ ${region} (${provinceLabel(fromRegion.oldCode)}) nhưng tỉnh / địa chỉ là ${newProvince(textNew)?.name ?? textNew} — chốt tỉnh cũ` };
    }
    return { ...base, oldCode: fromRegion.oldCode, newCode: fromRegion.newCode!, ...(channel ? { channel } : {}), source: `khu vực ${region}` };
  }
  if (fromText.oldCode) return { ...base, oldCode: fromText.oldCode, newCode: fromText.newCode!, source: 'địa chỉ' };
  if (textNew) return { ...base, newCode: textNew, source: 'địa chỉ', problem: `tỉnh mới ${newProvince(textNew)?.name ?? textNew} gồm nhiều tỉnh cũ — chốt tỉnh cũ` };
  return { ...base, source: '—', problem: 'không xác định được tỉnh' };
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  if (execute && process.env.TERRITORY_CONFIRM !== TERRITORY_CONFIRM) throw new Error(`Chạy thật cần TERRITORY_CONFIRM=${TERRITORY_CONFIRM}`);
  const decisions = loadDecisions();
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Thiếu MONGODB_URI');
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(process.env.MONGODB_DATABASE ?? 'inoxpran_erp');
    const [customers, employees, existing] = await Promise.all([
      db.collection('partners').find({ kind: { $in: ['CUSTOMER', 'BOTH'] } }).sort({ code: 1 }).toArray(),
      db.collection('employees').find({}).toArray(),
      db.collection('sales_territories').find({}).toArray(),
    ]);
    const employeeByCode = new Map(employees.map((row) => [String(row.code), row]));
    const employeeById = new Map(employees.map((row) => [String(row._id), row]));
    console.log(`== ${execute ? 'CHẠY THẬT' : 'CHẠY THỬ (không ghi gì)'} — ${new Date().toISOString()}`);
    console.log(`Khách: ${customers.length} · NVKD: ${employees.length} · phân vùng đang có: ${existing.length}`);

    // 1. Tỉnh của khách.
    const plans = customers.map((customer) => planCustomer(customer, decisions));
    // Quyết định "rep:MÃ_NV:lý do" — giao khách cho NVKD chỉ định (khác vùng thì ghi ngoại lệ); khách này không dùng để suy ra vùng.
    const repDecided = new Map<string, { employeeId: ObjectId; employeeName: string; reason: string }>();
    for (const plan of plans) {
      const decision = decisions.customers?.[plan.code] ?? '';
      if (!decision.startsWith('rep:')) continue;
      const [, code = '', ...reason] = decision.split(':');
      const employee = employeeByCode.get(code);
      if (!employee) throw new Error(`Quyết định khách ${plan.code}: không có NVKD mã ${code}`);
      repDecided.set(plan.code, { employeeId: employee._id as ObjectId, employeeName: String(employee.name), reason: reason.join(':').trim() || LEGACY_REASON });
    }
    const splitProvinces = new Set(plans.filter((plan) => plan.oldCode && plan.channel).map((plan) => plan.oldCode!));
    const keyOf = (plan: CustomerPlan) => (plan.oldCode ? `${plan.oldCode}/${splitProvinces.has(plan.oldCode) ? (plan.channel ?? 'RETAIL') : 'ALL'}` : '');

    // 2. Phân vùng suy ra.
    const owners = new Map<string, { employeeId: ObjectId; employeeName: string; source: string }>();
    for (const row of existing) owners.set(`${String(row.provinceCode)}/${String(row.channel)}`, { employeeId: row.employeeId as ObjectId, employeeName: String(row.employeeName), source: 'đang có' });
    const reps = new Map<string, Map<string, { name: string; customers: string[] }>>();
    for (const plan of plans) {
      const key = keyOf(plan);
      if (!key || !plan.salesRepId || repDecided.has(plan.code)) continue;
      const byRep = reps.get(key) ?? new Map();
      const entry = byRep.get(String(plan.salesRepId)) ?? { name: plan.salesRepName ?? '', customers: [] };
      entry.customers.push(plan.code);
      byRep.set(String(plan.salesRepId), entry);
      reps.set(key, byRep);
    }
    const conflicts: string[] = [];
    for (const [key, byRep] of reps) {
      if (owners.has(key)) continue;
      if (byRep.size === 1) {
        const [employeeId, entry] = [...byRep.entries()][0]!;
        owners.set(key, { employeeId: new ObjectId(employeeId), employeeName: String(employeeById.get(employeeId)?.name ?? entry.name), source: `từ ${entry.customers.length} khách` });
      } else {
        conflicts.push(`${key}: ${[...byRep.values()].map((entry) => `${entry.name} (${entry.customers.join(', ')})`).join(' / ')}`);
      }
    }
    for (const [key, code] of Object.entries(decisions.territories ?? {})) {
      const normalized = key.includes('/') ? key : `${key}/ALL`;
      if (code === '-') { owners.delete(normalized); continue; }
      const employee = employeeByCode.get(code);
      if (!employee) throw new Error(`Quyết định phân vùng ${key}: không có NVKD mã ${code}`);
      owners.set(normalized, { employeeId: employee._id as ObjectId, employeeName: String(employee.name), source: 'quyết định' });
    }
    const unresolvedConflicts = conflicts.filter((line) => !owners.has(line.split(':')[0]!));

    // 3. Áp vào khách.
    const assign: Array<{ plan: CustomerPlan; owner: { employeeId: ObjectId; employeeName: string } }> = [];
    const move: typeof assign = [];
    const exceptions: Array<{ plan: CustomerPlan; owner: { employeeName: string }; reason: string; rep?: { employeeId: ObjectId; employeeName: string } }> = [];
    for (const plan of plans) {
      const owner = owners.get(keyOf(plan)) ?? (plan.oldCode ? owners.get(`${plan.oldCode}/ALL`) : undefined);
      const decided = repDecided.get(plan.code);
      if (decided) {
        if (owner && !owner.employeeId.equals(decided.employeeId)) exceptions.push({ plan, owner, reason: decided.reason, rep: decided });
        else move.push({ plan, owner: decided });
        continue;
      }
      if (!owner) continue;
      if (!plan.salesRepId) { assign.push({ plan, owner }); continue; }
      if (plan.salesRepId.equals(owner.employeeId)) continue;
      const decision = decisions.customers?.[plan.code] ?? '';
      if (decision === 'move') move.push({ plan, owner });
      else exceptions.push({ plan, owner, reason: decision.startsWith('keep:') ? decision.slice(5).trim() || LEGACY_REASON : LEGACY_REASON });
    }

    // In báo cáo.
    console.log('\n-- Phân vùng theo NVKD');
    const byEmployee = new Map<string, string[]>();
    for (const [key, owner] of [...owners.entries()].sort()) {
      const { province, channel } = splitKey(key);
      byEmployee.set(owner.employeeName, [...(byEmployee.get(owner.employeeName) ?? []), `${provinceLabel(province)}${channelText(channel)} [${owner.source}]`]);
    }
    for (const [name, list] of byEmployee) console.log(`   ${name}: ${list.join(' · ')}`);
    console.log(`\n-- Xung đột (một vùng nhiều NVKD) chưa chốt: ${unresolvedConflicts.length}`);
    for (const line of unresolvedConflicts) console.log(`   ${line}`);
    const problems = plans.filter((plan) => plan.problem);
    console.log(`\n-- Khách cần chốt tỉnh: ${problems.length}`);
    for (const plan of problems) console.log(`   ${plan.code} ${plan.name} — ${plan.problem}`);
    console.log(`\n-- Khách được gán tỉnh: ${plans.filter((plan) => plan.oldCode).length}/${plans.length} (chỉ biết tỉnh mới: ${plans.filter((plan) => !plan.oldCode && plan.newCode).length})`);
    console.log(`\n-- Khách chưa có NVKD → gán NVKD của vùng: ${assign.length}`);
    for (const { plan, owner } of assign) console.log(`   ${plan.code} ${plan.name} · ${provinceLabel(plan.oldCode)}${channelText(plan.channel ?? '')} → ${owner.employeeName}`);
    console.log(`\n-- Khách chuyển NVKD theo vùng (quyết định "move"): ${move.length}`);
    for (const { plan, owner } of move) console.log(`   ${plan.code} ${plan.name} · ${plan.salesRepName} → ${owner.employeeName}`);
    console.log(`\n-- Khách giữ NVKD khác vùng (ngoại lệ): ${exceptions.length}`);
    for (const { plan, owner, reason, rep } of exceptions) console.log(`   ${plan.code} ${plan.name} · ${rep ? `${plan.salesRepName ?? '—'} → ${rep.employeeName}` : plan.salesRepName} (vùng: ${owner.employeeName}) — ${reason}`);

    if (!execute) {
      console.log('\n== Chạy thử xong. Chạy thật: thêm --execute và TERRITORY_CONFIRM (kèm file quyết định nếu có).');
      return;
    }
    const now = new Date();
    for (const plan of plans) {
      if (!plan.newCode) continue;
      const current = newProvince(plan.newCode);
      await db.collection('partners').updateOne({ _id: plan.id }, {
        $set: {
          ...(plan.oldCode ? { provinceOldCode: plan.oldCode } : {}),
          provinceNewCode: plan.newCode,
          ...(current ? { province: current.name } : {}),
          ...(plan.oldCode && splitProvinces.has(plan.oldCode) ? { territoryChannel: plan.channel ?? 'RETAIL' } : {}),
        },
      });
    }
    const existingKeys = new Set(existing.map((row) => `${String(row.provinceCode)}/${String(row.channel)}`));
    const inserts = [...owners.entries()].filter(([key]) => !existingKeys.has(key)).map(([key, owner]) => {
      const { province, channel } = splitKey(key);
      return { _id: new ObjectId(), provinceCode: province, channel, employeeId: owner.employeeId, employeeName: owner.employeeName, createdAt: now, updatedAt: now };
    });
    if (inserts.length) await db.collection('sales_territories').insertMany(inserts);
    for (const { plan, owner } of [...assign, ...move]) {
      await db.collection('partners').updateOne({ _id: plan.id }, { $set: { salesRepId: owner.employeeId, salesRepName: owner.employeeName, updatedAt: now }, $unset: { territoryException: '' }, $inc: { version: 1 } });
    }
    for (const { plan, reason, rep } of exceptions) {
      await db.collection('partners').updateOne({ _id: plan.id }, {
        $set: { ...(rep ? { salesRepId: rep.employeeId, salesRepName: rep.employeeName } : {}), territoryException: { reason, byName: 'Dựng phân vùng (script)', at: now.toISOString() }, updatedAt: now },
        $inc: { version: 1 },
      });
    }
    await db.collection('audit_events').insertOne({
      _id: new ObjectId(),
      action: 'SALES_TERRITORY_REBUILT',
      entityType: 'System',
      entityId: 'sales_territories',
      actorEmail: 'rebuild-sales-territories',
      metadata: {
        territories: inserts.map((row) => `${row.provinceCode}/${row.channel} → ${row.employeeName}`),
        assigned: assign.map(({ plan, owner }) => `${plan.code} → ${owner.employeeName}`),
        moved: move.map(({ plan, owner }) => `${plan.code}: ${plan.salesRepName} → ${owner.employeeName}`),
        exceptions: exceptions.map(({ plan }) => plan.code),
        conflicts: unresolvedConflicts,
        rule: 'PV-01',
      },
      occurredAt: now,
    });
    console.log(`\n== Xong: thêm ${inserts.length} vùng, gán ${assign.length} khách, chuyển ${move.length}, ngoại lệ ${exceptions.length}.`);
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

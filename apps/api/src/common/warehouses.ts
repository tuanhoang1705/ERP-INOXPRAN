import type { ClientSession, Db, ObjectId } from 'mongodb';

/**
 * Kho hàng lỗi (purpose = DEFECTIVE): nhận sản phẩm lỗi khách trả khi bảo hành đổi mới / hoàn tiền, chờ trả nhà cung cấp hoặc hủy.
 * Không bán ra, không tính vào giá trị tồn kho bán được và cảnh báo dưới định mức.
 */
/**
 * Kho hàng mẫu đang hoạt động (purpose = SAMPLE, WH-SAMPLE-01, 11/11/2026): xuất hàng mẫu / kiểm định / xuất tặng; không bán ra, không
 * cảnh báo dưới định mức, không tính vào khả dụng bán.
 */
export async function sampleWarehouseIds(db: Db, session?: ClientSession, activeOnly = false): Promise<ObjectId[]> {
  const rows = await db.collection('warehouses').find({ purpose: 'SAMPLE', ...(activeOnly ? { active: true } : {}) }, { projection: { _id: 1 }, ...(session ? { session } : {}) }).toArray();
  return rows.map((row) => row._id as ObjectId);
}

export async function defectiveWarehouseIds(db: Db, session?: ClientSession): Promise<ObjectId[]> {
  const rows = await db.collection('warehouses').find({ purpose: 'DEFECTIVE' }, { projection: { _id: 1 }, ...(session ? { session } : {}) }).toArray();
  return rows.map((row) => row._id as ObjectId);
}

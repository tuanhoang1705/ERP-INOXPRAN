import type { ClientSession, Db, ObjectId } from 'mongodb';

/**
 * Kho hàng lỗi (purpose = DEFECTIVE): nhận sản phẩm lỗi khách trả khi bảo hành đổi mới / hoàn tiền, chờ trả nhà cung cấp hoặc hủy.
 * Không bán ra, không tính vào giá trị tồn kho bán được và cảnh báo dưới định mức.
 */
export async function defectiveWarehouseIds(db: Db, session?: ClientSession): Promise<ObjectId[]> {
  const rows = await db.collection('warehouses').find({ purpose: 'DEFECTIVE' }, { projection: { _id: 1 }, ...(session ? { session } : {}) }).toArray();
  return rows.map((row) => row._id as ObjectId);
}

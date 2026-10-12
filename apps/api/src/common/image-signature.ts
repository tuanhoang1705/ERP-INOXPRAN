/**
 * Nhận diện ảnh theo chữ ký nhị phân (magic bytes) thay vì tin vào Content-Type/đuôi file do trình duyệt gửi lên.
 * Chỉ chấp nhận PNG, JPEG, WebP — không nhận SVG/HTML (có thể chứa mã chạy được).
 */
export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';

export function detectImageType(data: Uint8Array): ImageType | null {
  const starts = (bytes: number[], offset = 0) => data.length >= offset + bytes.length && bytes.every((byte, index) => data[offset + index] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

export type StoredFileType = ImageType | 'application/pdf';

/** Ảnh như trên; thêm PDF (chữ ký "%PDF-") cho tài liệu hồ sơ / chứng từ khi được phép. */
export function detectFileType(data: Uint8Array, allowPdf = false): StoredFileType | null {
  const image = detectImageType(data);
  if (image) return image;
  const pdf = [0x25, 0x50, 0x44, 0x46, 0x2d];
  if (allowPdf && data.length >= pdf.length && pdf.every((byte, index) => data[index] === byte)) return 'application/pdf';
  return null;
}

/** Tên file an toàn để lưu/hiển thị: bỏ đường dẫn và ký tự điều khiển, giới hạn độ dài. */
export function safeFileName(raw: string | undefined, fallback: string): string {
  let decoded = raw ?? '';
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // giữ nguyên chuỗi gốc nếu không giải mã được
  }
  const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '').trim();
  const name = clean(decoded.split(/[\\/]/).pop() ?? '');
  // Tên mặc định lấy theo số chứng từ (vd. số phiếu BH tự nhập "BH003/0826") cũng không được chứa ký tự đường dẫn.
  return (name || clean(fallback.replace(/[\\/]/g, '-'))).slice(0, 120);
}

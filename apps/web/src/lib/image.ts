/**
 * Nén ảnh trên trình duyệt trước khi tải lên (28/10/2026): ảnh điện thoại 3–15 MB còn khoảng 300–550 KB,
 * tải dưới 1 giây trên 4G, máy chủ quét mã độc nhanh hơn và kho S3 nhẹ hơn.
 *
 * 1. Ảnh đã nhỏ thì giữ nguyên (nén lại chỉ làm mờ thêm).
 * 2. Tỉ lệ thu nhỏ k = min(1, cạnh dài tối đa / cạnh dài, √(số điểm ảnh tối đa / (W·H))).
 * 3. Giải mã theo chiều xoay trong EXIF; thu nhỏ từng bước tối đa ½ với nội suy chất lượng cao
 *    (tránh răng cưa, vân moiré trên mặt inox và chữ trên tem).
 * 4. Xuất WebP nếu trình duyệt mã hóa được (nhỏ hơn JPEG ~25–34% cùng chất lượng); Safari / iPhone chỉ trả PNG
 *    cho yêu cầu WebP nên lùi về JPEG.
 * 5. Chất lượng: thử mức đầu, quá dung lượng mục tiêu thì chia đôi khoảng chất lượng (tìm nhị phân, ít lần mã hóa);
 *    vẫn quá trần thì hạ cạnh dài một nấc.
 * 6. Ảnh nén không nhỏ hơn ảnh gốc thì dùng ảnh gốc. Ảnh xuất từ canvas không còn EXIF (bỏ luôn tọa độ GPS).
 */

export type ImageProfile = 'photo' | 'screenshot';

export interface ImageProfileSpec {
  /** Cạnh dài tối đa (px). */
  maxSide: number;
  /** Cạnh dài khi vẫn vượt trần dung lượng ở chất lượng thấp nhất. */
  fallbackSide: number;
  /** Số điểm ảnh tối đa (ảnh rất dài / rất rộng). */
  maxPixels: number;
  quality: number;
  minQuality: number;
  /** Dung lượng mục tiêu: vượt thì giảm chất lượng. */
  targetBytes: number;
  /** Trần dung lượng: vượt ở chất lượng thấp nhất thì thu nhỏ thêm. */
  capBytes: number;
  /** Ảnh không lớn hơn mức này (và không vượt cạnh dài, trừ ảnh chụp màn hình) giữ nguyên. */
  keepBelowBytes: number;
  /** Ảnh chụp màn hình: chỉ xét dung lượng, không xét kích thước. */
  keepIgnoresSize: boolean;
}

const KB = 1024;
const MB = 1024 * KB;

export const IMAGE_PROFILES: Record<ImageProfile, ImageProfileSpec> = {
  // Ảnh chụp sản phẩm / hiện trạng / phiếu đã ký: 1920 px vẫn đọc rõ tem, số máy khi phóng to.
  photo: { maxSide: 1920, fallbackSide: 1600, maxPixels: 2_800_000, quality: 0.82, minQuality: 0.5, targetBytes: 500 * KB, capBytes: 1.5 * MB, keepBelowBytes: 400 * KB, keepIgnoresSize: false },
  // Ảnh chụp màn hình Zalo đối chiếu: chữ phải nét, chỉ nén ảnh lớn.
  screenshot: { maxSide: 2400, fallbackSide: 1920, maxPixels: 4_000_000, quality: 0.9, minQuality: 0.7, targetBytes: 2 * MB, capBytes: 4 * MB, keepBelowBytes: 2 * MB, keepIgnoresSize: true },
};

/** Safari trên iPhone không vẽ được canvas lớn hơn 16,7 triệu điểm ảnh. */
export const MAX_CANVAS_PIXELS = 16_000_000;

export interface Size {
  width: number;
  height: number;
}

/** Kích thước sau khi thu nhỏ theo cạnh dài và số điểm ảnh tối đa (không phóng to). */
export function scaledSize(width: number, height: number, maxSide: number, maxPixels: number): Size {
  const k = Math.min(1, maxSide / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Các bước thu nhỏ, mỗi bước tối đa ½ (bước cuối đúng kích thước đích); bước nào quá lớn với canvas thì thu mạnh hơn. */
export function halvingSteps(from: Size, to: Size, maxPixels = MAX_CANVAS_PIXELS): Size[] {
  const steps: Size[] = [];
  let { width, height } = from;
  while (width > to.width || height > to.height) {
    let next = { width: Math.max(to.width, Math.round(width / 2)), height: Math.max(to.height, Math.round(height / 2)) };
    if (next.width * next.height > maxPixels) {
      const shrink = Math.sqrt(maxPixels / (next.width * next.height));
      next = { width: Math.max(to.width, Math.floor(next.width * shrink)), height: Math.max(to.height, Math.floor(next.height * shrink)) };
    }
    steps.push(next);
    ({ width, height } = next);
  }
  return steps.length ? steps : [{ ...to }];
}

/** Có giữ ảnh gốc không (đã đủ nhỏ). */
export function keepOriginal(bytes: number, size: Size | null, spec: ImageProfileSpec): boolean {
  if (bytes > spec.keepBelowBytes) return false;
  return spec.keepIgnoresSize || (size !== null && Math.max(size.width, size.height) <= spec.maxSide);
}

/**
 * Chọn chất lượng: mức đầu vừa mục tiêu thì dùng; không thì tìm nhị phân trong [minQuality, quality] tối đa `rounds` lần,
 * lấy mức cao nhất còn vừa mục tiêu, không có thì lấy bản nhỏ nhất.
 */
export async function pickQuality<T extends { size: number }>(
  encode: (quality: number) => Promise<T>,
  spec: Pick<ImageProfileSpec, 'quality' | 'minQuality' | 'targetBytes'>,
  rounds = 2,
): Promise<T> {
  let best = await encode(spec.quality);
  if (best.size <= spec.targetBytes) return best;
  let low = spec.minQuality;
  let high = spec.quality;
  for (let round = 0; round < rounds; round += 1) {
    const quality = (low + high) / 2;
    const result = await encode(quality);
    if (result.size <= spec.targetBytes) {
      best = result;
      low = quality;
    } else {
      high = quality;
      if (best.size > spec.targetBytes && result.size < best.size) best = result;
    }
  }
  return best;
}

type Decoded = { source: CanvasImageSource; size: Size; release: () => void };

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, size: { width: bitmap.width, height: bitmap.height }, release: () => bitmap.close() };
    } catch {
      // Trình duyệt cũ / không nhận tùy chọn: dùng <img> (cũng xoay theo EXIF).
    }
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return { source: image, size: { width: image.naturalWidth, height: image.naturalHeight }, release: () => URL.revokeObjectURL(url) };
}

let outputType: Promise<'image/webp' | 'image/jpeg'> | undefined;

/** WebP nếu trình duyệt thật sự mã hóa được (Safari trả PNG cho yêu cầu WebP). */
function detectOutputType() {
  outputType ??= new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    canvas.toBlob((blob) => resolve(blob?.type === 'image/webp' ? 'image/webp' : 'image/jpeg'), 'image/webp', 0.8);
  });
  return outputType;
}

/** Giải phóng bộ nhớ canvas ngay (Safari giữ canvas cũ, quá tổng bộ nhớ canvas thì lỗi). */
function dispose(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

function draw(source: CanvasImageSource, from: Size, steps: Size[], opaque: boolean): HTMLCanvasElement {
  let current: CanvasImageSource = source;
  let currentSize = from;
  let previous: HTMLCanvasElement | null = null;
  for (const [index, step] of steps.entries()) {
    const canvas = document.createElement('canvas');
    canvas.width = step.width;
    canvas.height = step.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    // JPEG không có nền trong suốt: lót nền trắng thay vì đen.
    if (opaque && index === steps.length - 1) {
      context.fillStyle = '#fff';
      context.fillRect(0, 0, step.width, step.height);
    }
    context.drawImage(current, 0, 0, currentSize.width, currentSize.height, 0, 0, step.width, step.height);
    if (previous) dispose(previous);
    previous = canvas;
    current = canvas;
    currentSize = step;
  }
  if (!previous) throw new Error('canvas');
  return previous;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode'))), type, quality));
}

/**
 * Trả ảnh đã nén (File mới, đổi đuôi .webp / .jpg) hoặc chính ảnh gốc khi đã đủ nhỏ, không giải mã được
 * (VD HEIC trên Chrome — để máy chủ báo lỗi rõ ràng) hoặc bản nén không nhỏ hơn.
 */
export async function prepareImage(file: File, profile: ImageProfile): Promise<File> {
  const spec = IMAGE_PROFILES[profile];
  if (!file.type.startsWith('image/') || keepOriginal(file.size, null, spec)) return file;
  let decoded: Decoded;
  try {
    decoded = await decode(file);
  } catch {
    return file;
  }
  try {
    if (keepOriginal(file.size, decoded.size, spec)) return file;
    const type = await detectOutputType();
    let best: Blob | null = null;
    for (const side of [spec.maxSide, spec.fallbackSide]) {
      const target = scaledSize(decoded.size.width, decoded.size.height, side, spec.maxPixels);
      const canvas = draw(decoded.source, decoded.size, halvingSteps(decoded.size, target), type === 'image/jpeg');
      try {
        let blob = await pickQuality((quality) => toBlob(canvas, type, quality), spec);
        if (blob.size > spec.capBytes) {
          const lowest = await toBlob(canvas, type, spec.minQuality);
          if (lowest.size < blob.size) blob = lowest;
        }
        if (!best || blob.size < best.size) best = blob;
      } finally {
        dispose(canvas);
      }
      if (best.size <= spec.capBytes) break;
    }
    if (!best || best.size >= file.size) return file;
    const extension = best.type === 'image/webp' ? '.webp' : '.jpg';
    const base = file.name.replace(/\.[^.]+$/, '') || 'anh';
    return new File([best], `${base}${extension}`, { type: best.type, lastModified: Date.now() });
  } catch {
    return file;
  } finally {
    decoded.release();
  }
}

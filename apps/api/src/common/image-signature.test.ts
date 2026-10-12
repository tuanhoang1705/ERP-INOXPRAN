import { describe, expect, it } from 'vitest';
import { detectFileType, detectImageType, safeFileName } from './image-signature';

describe('detectImageType', () => {
  it('nhận đúng PNG, JPEG, WebP theo chữ ký file', () => {
    expect(detectImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe('image/png');
    expect(detectImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe('image/jpeg');
    expect(detectImageType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0x56]))).toBe('image/webp');
  });

  it('từ chối SVG / HTML / file giả đuôi ảnh', () => {
    expect(detectImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(detectImageType(new TextEncoder().encode('<html>'))).toBeNull();
    expect(detectImageType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x41, 0x56, 0x49, 0x20]))).toBeNull();
    expect(detectImageType(new Uint8Array())).toBeNull();
  });
});

describe('detectFileType', () => {
  const pdf = new TextEncoder().encode('%PDF-1.7 %âãÏÓ');
  it('chỉ nhận PDF khi được phép, vẫn nhận ảnh', () => {
    expect(detectFileType(pdf, true)).toBe('application/pdf');
    expect(detectFileType(pdf)).toBeNull();
    expect(detectFileType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), true)).toBe('image/jpeg');
  });

  it('từ chối file giả PDF / HTML', () => {
    expect(detectFileType(new TextEncoder().encode('<html>%PDF-'), true)).toBeNull();
    expect(detectFileType(new TextEncoder().encode('%PD'), true)).toBeNull();
  });
});

describe('safeFileName', () => {
  it('bỏ đường dẫn, ký tự nguy hiểm và giải mã tiếng Việt', () => {
    expect(safeFileName(encodeURIComponent('Ảnh Zalo xác nhận.png'), 'x')).toBe('Ảnh Zalo xác nhận.png');
    expect(safeFileName('..%2F..%2Fetc%2Fpasswd', 'x')).toBe('passwd');
    expect(safeFileName('a"<b>.png', 'x')).toBe('ab.png');
    expect(safeFileName(undefined, 'anh-1.png')).toBe('anh-1.png');
    expect(safeFileName(undefined, 'bang-chung-BH003/0826')).toBe('bang-chung-BH003-0826');
  });
});

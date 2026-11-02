import { describe, expect, it } from 'vitest';
import { IMAGE_PROFILES, halvingSteps, keepOriginal, pickQuality, scaledSize } from './image';

const photo = IMAGE_PROFILES.photo;

describe('scaledSize', () => {
  it('ảnh iPhone 12 MP 4032×3024 về cạnh dài 1920', () => {
    expect(scaledSize(4032, 3024, 1920, photo.maxPixels)).toEqual({ width: 1920, height: 1440 });
  });
  it('ảnh dọc giữ đúng tỉ lệ', () => {
    expect(scaledSize(3024, 4032, 1920, photo.maxPixels)).toEqual({ width: 1440, height: 1920 });
  });
  it('ảnh panorama rất dài bị giới hạn theo số điểm ảnh', () => {
    const size = scaledSize(12000, 3000, 1920, photo.maxPixels);
    expect(size.width).toBe(1920);
    expect(size.width * size.height).toBeLessThanOrEqual(photo.maxPixels);
    const square = scaledSize(4000, 4000, 4000, 2_800_000);
    expect(square.width * square.height).toBeLessThanOrEqual(2_800_000);
  });
  it('không phóng to ảnh nhỏ', () => {
    expect(scaledSize(800, 600, 1920, photo.maxPixels)).toEqual({ width: 800, height: 600 });
  });
});

describe('halvingSteps', () => {
  it('mỗi bước giảm tối đa ½, bước cuối đúng kích thước đích', () => {
    const steps = halvingSteps({ width: 8000, height: 6000 }, { width: 1920, height: 1440 });
    expect(steps.at(-1)).toEqual({ width: 1920, height: 1440 });
    let previous = { width: 8000, height: 6000 };
    for (const step of steps) {
      expect(step.width).toBeGreaterThanOrEqual(Math.round(previous.width / 2));
      previous = step;
    }
  });
  it('bước đầu không vượt giới hạn canvas của iPhone', () => {
    const steps = halvingSteps({ width: 16320, height: 12240 }, { width: 1920, height: 1440 });
    for (const step of steps) expect(step.width * step.height).toBeLessThanOrEqual(16_000_000);
  });
  it('không cần thu nhỏ: một bước giữ nguyên kích thước', () => {
    expect(halvingSteps({ width: 1200, height: 900 }, { width: 1200, height: 900 })).toEqual([{ width: 1200, height: 900 }]);
  });
});

describe('keepOriginal', () => {
  it('ảnh nhỏ, không quá cạnh dài: giữ nguyên', () => {
    expect(keepOriginal(300 * 1024, { width: 1600, height: 1200 }, photo)).toBe(true);
  });
  it('ảnh nhỏ nhưng quá cạnh dài: vẫn nén', () => {
    expect(keepOriginal(300 * 1024, { width: 4000, height: 3000 }, photo)).toBe(false);
  });
  it('ảnh lớn: nén', () => {
    expect(keepOriginal(3 * 1024 * 1024, { width: 1600, height: 1200 }, photo)).toBe(false);
  });
  it('ảnh chụp màn hình dưới 2 MB: giữ nguyên dù dài', () => {
    expect(keepOriginal(1.5 * 1024 * 1024, null, IMAGE_PROFILES.screenshot)).toBe(true);
  });
});

describe('pickQuality', () => {
  // Mô phỏng dung lượng tăng theo chất lượng.
  const encoder = (bytesAt: (quality: number) => number) => {
    const tried: number[] = [];
    return { tried, encode: async (quality: number) => { tried.push(quality); return { size: bytesAt(quality), quality }; } };
  };
  it('mức đầu đã vừa mục tiêu: chỉ mã hóa một lần', async () => {
    const { tried, encode } = encoder(() => 300 * 1024);
    expect((await pickQuality(encode, photo)).quality).toBe(0.82);
    expect(tried).toHaveLength(1);
  });
  it('quá mục tiêu: lấy mức cao nhất còn vừa', async () => {
    const { tried, encode } = encoder((quality) => quality * 800 * 1024);
    const result = await pickQuality(encode, photo);
    expect(result.size).toBeLessThanOrEqual(photo.targetBytes);
    expect(result.quality).toBeCloseTo(0.58, 2);
    expect(tried.length).toBeLessThanOrEqual(3);
  });
  it('không mức nào vừa: lấy bản nhỏ nhất', async () => {
    const { encode } = encoder((quality) => 2_000_000 + quality * 1_000_000);
    const result = await pickQuality(encode, photo);
    expect(result.quality).toBeCloseTo(0.58, 2);
  });
});

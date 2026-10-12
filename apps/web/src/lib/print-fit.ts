/**
 * Tỷ lệ thu nhỏ để một chứng từ một trang (phiếu bảo hành…) luôn in vừa đúng 1 trang giấy.
 * Đo trên màn hình với bề rộng nội dung đúng bằng vùng in (chia cho tỷ lệ, vì tờ thu nhỏ thì chữ dàn rộng hơn),
 * tìm tỷ lệ lớn nhất mà chiều cao sau thu nhỏ vẫn vừa vùng in; kết quả gán vào biến CSS `--print-fit` (chỉ dùng khi in).
 */
const PX_PER_MM = 96 / 25.4;
const MIN_SCALE = 0.3;

/** Tìm nhị phân tỷ lệ lớn nhất trong [0,3; 1] thỏa chiều cao(tỷ lệ) × tỷ lệ ≤ chiều cao cho phép. */
export function findPrintScale(heightAt: (scale: number) => number, availablePx: number): number {
  const fits = (scale: number) => {
    const height = heightAt(scale);
    return Number.isFinite(height) && height * scale <= availablePx;
  };
  if (fits(1)) return 1;
  let low = MIN_SCALE;
  let high = 1;
  for (let step = 0; step < 10; step += 1) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return Math.floor(low * 1000) / 1000;
}

/**
 * Đo tờ phiếu (đang hiển thị trên màn hình) theo khổ in và đặt `--print-fit`; trả về tỷ lệ.
 * Đổi tạm bề rộng / chiều cao tối thiểu để đo rồi trả lại ngay trong cùng một lần chạy (không nháy hình).
 */
export function applyPrintFit(sheet: HTMLElement, page: { contentWidthMm: number; printableHeightMm: number }): number {
  const style = getComputedStyle(sheet);
  const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const previous = { width: sheet.style.width, minHeight: sheet.style.minHeight, boxSizing: sheet.style.boxSizing };
  sheet.style.boxSizing = 'border-box';
  sheet.style.minHeight = '0';
  const heightAt = (scale: number) => {
    sheet.style.width = `${(page.contentWidthMm * PX_PER_MM) / scale + padX}px`;
    return sheet.scrollHeight - padY;
  };
  const scale = findPrintScale(heightAt, (page.printableHeightMm - 1) * PX_PER_MM);
  Object.assign(sheet.style, previous);
  sheet.style.setProperty('--print-fit', String(scale));
  return scale;
}

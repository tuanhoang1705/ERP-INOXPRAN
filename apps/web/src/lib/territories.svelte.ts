/**
 * Bảng phân vùng NVKD theo tỉnh cũ (PV-01, 30/10/2026) dùng chung cho các form khách / phiếu BH: tải một lần, tải lại khi trang
 * Phân vùng NVKD lưu thay đổi.
 */
import type { SalesTerritoryView } from '@inoxpran/contracts';
import { api } from './api';

export const territories = $state<{ rows: SalesTerritoryView[]; loaded: boolean }>({ rows: [], loaded: false });
let pending: Promise<void> | null = null;

export function loadTerritories(force = false): Promise<void> {
  if (territories.loaded && !force) return Promise.resolve();
  pending ??= api<SalesTerritoryView[]>('/territories')
    .then((rows) => {
      territories.rows = rows;
      territories.loaded = true;
    })
    .catch(() => undefined)
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** Tỉnh cũ có tách kênh (nhà phân phối / bán lẻ do người khác nhau phụ trách). */
export function splitProvince(provinceCode: string | null | undefined): boolean {
  return Boolean(provinceCode) && territories.rows.some((row) => row.provinceCode === provinceCode && row.channel !== 'ALL');
}

/** NVKD phụ trách (tỉnh cũ, kênh); null = vùng chưa giao ai. */
export function territoryOwner(provinceCode: string | null | undefined, channel: string | null | undefined): SalesTerritoryView | null {
  if (!provinceCode) return null;
  const rows = territories.rows.filter((row) => row.provinceCode === provinceCode);
  return rows.find((row) => row.channel === 'ALL') ?? (channel ? rows.find((row) => row.channel === channel) : undefined) ?? null;
}

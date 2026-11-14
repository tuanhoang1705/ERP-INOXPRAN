import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PRICE_CATALOG_KEY_SHA256 } from './price-catalog.config';

/** A separate read-only capability for the price app; never an ERP employee session or JWT. */
export function validCatalogKey(received: unknown, expected: unknown): boolean {
  if (typeof received !== 'string' || typeof expected !== 'string' || expected.length < 64) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function validCatalogFingerprint(received: unknown, fingerprint: unknown): boolean {
  if (typeof received !== 'string' || !/^[a-f0-9]{64}$/i.test(received) || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint)) return false;
  return timingSafeEqual(createHash('sha256').update(received).digest(), Buffer.from(fingerprint, 'hex'));
}

@Injectable()
export class PriceCatalogGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext): boolean {
    const key = this.config.get<string>('PRICE_CATALOG_ACCESS_KEY');
    const fingerprint = this.config.get<string>('PRICE_CATALOG_ACCESS_KEY_HASH', PRICE_CATALOG_KEY_SHA256);
    if (!key && !/^[a-f0-9]{64}$/i.test(fingerprint ?? '')) throw new ServiceUnavailableException({ code: 'PRICE_CATALOG_DISABLED', message: 'API bảng giá cho app chưa được kích hoạt trên ERP.' });
    const request = context.switchToHttp().getRequest<{ method: string; headers: Record<string, unknown> }>();
    const valid = key ? validCatalogKey(request.headers['x-catalog-key'], key) : validCatalogFingerprint(request.headers['x-catalog-key'], fingerprint);
    if (request.method !== 'GET' || !valid) {
      throw new UnauthorizedException({ code: 'CATALOG_ACCESS_DENIED', message: 'Bản app chưa được cấp quyền đọc bảng giá. Vui lòng liên hệ quản trị ERP.' });
    }
    return true;
  }
}

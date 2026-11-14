import { describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { ObjectId, type Db } from 'mongodb';
import { createHash } from 'node:crypto';
import { PriceCatalogGuard, validCatalogKey, validCatalogFingerprint } from './price-catalog.guard';
import { PriceCatalogService } from './price-catalog.service';
import type { PriceListService } from './price-list.service';
import type { EvidenceIntakeService } from '../../common/evidence-intake.service';

const key = 'a'.repeat(64);
const context = (method: string, token?: string) => ({ switchToHttp: () => ({ getRequest: () => ({ method, headers: { 'x-catalog-key': token } }) }) }) as unknown as ExecutionContext;

describe('read-only price catalog access', () => {
  it('rejects missing, wrong and malformed keys without byte-length errors', () => {
    expect(validCatalogKey(undefined, key)).toBe(false);
    expect(validCatalogKey('b'.repeat(64), key)).toBe(false);
    expect(validCatalogKey('😀'.repeat(32), key)).toBe(false);
    expect(validCatalogKey(key, key)).toBe(true);
  });
  it('is disabled if both the key and its deployment fingerprint are absent', () => {
    const guard = new PriceCatalogGuard(new ConfigService({ PRICE_CATALOG_ACCESS_KEY_HASH: '' }));
    expect(() => guard.canActivate(context('GET', key))).toThrow(ServiceUnavailableException);
  });
  it('supports a deployment fingerprint without storing the app key on the ERP', () => {
    const fingerprint = createHash('sha256').update(key).digest('hex');
    expect(validCatalogFingerprint(key, fingerprint)).toBe(true);
    expect(validCatalogFingerprint('b'.repeat(64), fingerprint)).toBe(false);
    expect(validCatalogFingerprint('😀'.repeat(32), fingerprint)).toBe(false);
    const guard = new PriceCatalogGuard(new ConfigService({ PRICE_CATALOG_ACCESS_KEY_HASH: fingerprint }));
    expect(guard.canActivate(context('GET', key))).toBe(true);
    expect(() => guard.canActivate(context('POST', key))).toThrow(UnauthorizedException);
  });
  it('permits only GET with the configured catalog key', () => {
    const guard = new PriceCatalogGuard(new ConfigService({ PRICE_CATALOG_ACCESS_KEY: key }));
    expect(() => guard.canActivate(context('GET'))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context('POST', key))).toThrow(UnauthorizedException);
    expect(guard.canActivate(context('GET', key))).toBe(true);
  });
});

describe('read-only price catalog data boundaries', () => {
  it('uses the existing ERP price engine and omits internal price book metadata', async () => {
    const list = vi.fn().mockResolvedValue({ books: [{ internal: true }], rows: [{ sku: 'IP-01' }] });
    const service = new PriceCatalogService({} as Db, { list } as unknown as PriceListService, {} as EvidenceIntakeService);
    expect(await service.priceList()).toEqual({ rows: [{ sku: 'IP-01' }] });
    expect(list).toHaveBeenCalledWith({}, null);
  });
  it('returns only the approved promotion fields', async () => {
    const category = new ObjectId();
    const promotion = { _id: new ObjectId(), code: 'KM01', name: 'Ưu đãi', discountRate: '5', status: 'ACTIVE', validFrom: new Date(), validTo: new Date(), categoryIds: [category], createdBy: 'PRIVATE', audit: 'PRIVATE' };
    const db = { collection: (name: string) => ({ find: () => ({ sort: () => ({ toArray: async () => [promotion] }), toArray: async () => [{ _id: category, name: 'Ấm' }] }) }) } as unknown as Db;
    const service = new PriceCatalogService(db, {} as PriceListService, {} as EvidenceIntakeService);
    const [result] = await service.promotions();
    expect(result?.categoryNames).toEqual(['Ấm']);
    expect(result).not.toHaveProperty('createdBy');
    expect(result).not.toHaveProperty('audit');
  });
  it('refuses an image unless it is the active product primary image', async () => {
    const findOne = vi.fn().mockResolvedValue(null);
    const read = vi.fn();
    const service = new PriceCatalogService({ collection: () => ({ findOne }) } as unknown as Db, {} as PriceListService, { read } as unknown as EvidenceIntakeService);
    const product = new ObjectId(), image = new ObjectId();
    await expect(service.image(String(product), String(image))).rejects.toThrow('Không tìm thấy ảnh sản phẩm.');
    expect(findOne).toHaveBeenCalledWith({ _id: product, status: 'ACTIVE', primaryImageId: image }, expect.anything());
    expect(read).not.toHaveBeenCalled();
  });
  it('requires the product image purpose and blocks private attachments', async () => {
    const product = new ObjectId(), image = new ObjectId();
    const findOne = vi.fn().mockResolvedValueOnce({ _id: product }).mockResolvedValueOnce(null);
    const service = new PriceCatalogService({ collection: () => ({ findOne }) } as unknown as Db, {} as PriceListService, { read: vi.fn() } as unknown as EvidenceIntakeService);
    await expect(service.image(String(product), String(image))).rejects.toThrow('Không tìm thấy ảnh sản phẩm.');
    expect(findOne.mock.calls[1]?.[0]).toMatchObject({ entityType: 'Product', entityId: product, purpose: 'PRODUCT_IMAGE', status: 'LINKED' });
  });
});

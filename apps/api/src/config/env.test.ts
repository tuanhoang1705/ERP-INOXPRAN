import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './env';

const base = { MONGODB_URI: 'mongodb://localhost:27017', JWT_SECRET: 'x'.repeat(32), MFA_ENCRYPTION_KEY: 'y'.repeat(32) };

describe('cấu hình lưu trữ S3', () => {
  it('máy dev: giữ lại cấu hình S3 giả lập (không bị lược bỏ)', () => {
    const env = validateEnvironment({
      ...base, AWS_S3_BUCKET: 'inoxpran-erp-local', S3_ENDPOINT: 'http://localhost:9090', S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: 'local-dev', S3_SECRET_ACCESS_KEY: 'local-dev', S3_AUTO_CREATE_BUCKET: 'true',
    });
    expect(env).toMatchObject({ S3_ENDPOINT: 'http://localhost:9090', S3_ACCESS_KEY_ID: 'local-dev', S3_AUTO_CREATE_BUCKET: 'true' });
  });

  it('production: bắt buộc có bucket, không cho tự tạo bucket', () => {
    expect(() => validateEnvironment({ ...base, NODE_ENV: 'production' })).toThrow(/AWS_S3_BUCKET/);
    expect(() => validateEnvironment({ ...base, NODE_ENV: 'production', AWS_S3_BUCKET: 'b', S3_AUTO_CREATE_BUCKET: 'true' })).toThrow(/Terraform/);
    expect(validateEnvironment({ ...base, NODE_ENV: 'production', AWS_S3_BUCKET: 'inoxpran-prod-documents' }).AWS_S3_BUCKET).toBe('inoxpran-prod-documents');
  });

  it('khóa truy cập phải khai báo đủ cặp', () => {
    expect(() => validateEnvironment({ ...base, S3_ACCESS_KEY_ID: 'only-id' })).toThrow(/cùng nhau/);
  });
});

describe('cấu hình quét mã độc', () => {
  it('mặc định quét bằng ClamAV; production không được tắt quét', () => {
    expect(validateEnvironment(base)).toMatchObject({ MALWARE_SCAN_MODE: 'clamav', CLAMAV_HOST: 'localhost', CLAMAV_PORT: 3310 });
    expect(validateEnvironment({ ...base, MALWARE_SCAN_MODE: 'off' }).MALWARE_SCAN_MODE).toBe('off');
    expect(() => validateEnvironment({ ...base, NODE_ENV: 'production', AWS_S3_BUCKET: 'b', MALWARE_SCAN_MODE: 'off' })).toThrow(/bắt buộc quét mã độc/);
  });
});

import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

export const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  MONGODB_URI: z.string().min(1),
  MONGODB_DATABASE: z.string().min(1).default('inoxpran_erp'),
  JWT_SECRET: z.string().min(32),
  MFA_ENCRYPTION_KEY: z.string().min(32),
  COOKIE_SECURE: booleanString,
  MFA_ENFORCE_PRIVILEGED: booleanString,
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  /** development | staging | production — hiển thị trên màn giám sát, quyết định mức cảnh báo sao lưu. */
  APP_ENV: z.string().default('development'),
  /** Tag image đang chạy (deploy.ps1 truyền IMAGE_TAG). */
  APP_VERSION: z.string().default('dev'),
  AWS_S3_BUCKET: z.string().optional(),
  /** S3 giả lập ở máy dev; môi trường thật bỏ trống (dùng endpoint AWS và IAM role của ECS task). */
  S3_ENDPOINT: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_AUTO_CREATE_BUCKET: z.enum(['true', 'false']).optional(),
  /** Quét mã độc file tải lên: clamav (mặc định) hoặc off (chỉ máy dev). */
  MALWARE_SCAN_MODE: z.enum(['clamav', 'off']).default('clamav'),
  CLAMAV_HOST: z.string().min(1).default('localhost'),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  AWS_SES_FROM_EMAIL: z.string().email().optional(),
  AWS_REGION: z.string().default('ap-southeast-1'),
  MISA_APP_ID: z.string().optional(),
  MISA_ACCESS_CODE: z.string().optional(),
  MISA_ORG_COMPANY_CODE: z.string().optional(),
  MISA_BASE_URL: z.string().url().default('https://actapp.misa.vn'),
}).superRefine((env, context) => {
  if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY)) {
    context.addIssue({ code: 'custom', path: ['S3_SECRET_ACCESS_KEY'], message: 'S3_ACCESS_KEY_ID và S3_SECRET_ACCESS_KEY phải khai báo cùng nhau' });
  }
  if (env.NODE_ENV === 'production') {
    // Ảnh bằng chứng đối chiếu là bắt buộc trong quy trình xuất kho → môi trường thật phải có S3.
    if (!env.AWS_S3_BUCKET) context.addIssue({ code: 'custom', path: ['AWS_S3_BUCKET'], message: 'Môi trường production cần AWS_S3_BUCKET' });
    if (env.S3_AUTO_CREATE_BUCKET === 'true') context.addIssue({ code: 'custom', path: ['S3_AUTO_CREATE_BUCKET'], message: 'Không tự tạo bucket ở production (bucket do Terraform quản lý)' });
    if (env.MALWARE_SCAN_MODE !== 'clamav') context.addIssue({ code: 'custom', path: ['MALWARE_SCAN_MODE'], message: 'Production bắt buộc quét mã độc file tải lên (MALWARE_SCAN_MODE=clamav)' });
  }
});

export type Environment = z.infer<typeof EnvironmentSchema>;

export function validateEnvironment(raw: Record<string, unknown>): Environment {
  return EnvironmentSchema.parse(raw);
}

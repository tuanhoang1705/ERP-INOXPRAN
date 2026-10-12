import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * Lưu file chứng từ (ảnh bằng chứng đối chiếu…) trên Amazon S3.
 * - Môi trường thật: bucket do Terraform tạo (chặn truy cập công khai, mã hóa mặc định AES256, lưu phiên bản),
 *   thông tin đăng nhập lấy từ IAM role của ECS task — không cần khóa truy cập trong biến môi trường.
 * - Máy dev: S3 giả lập (docker-compose dịch vụ `s3`) với S3_ENDPOINT, S3_FORCE_PATH_STYLE, S3_ACCESS_KEY_ID/SECRET.
 * Trình duyệt không truy cập S3 trực tiếp: API đọc file rồi trả về sau khi đã kiểm tra quyền xem phiếu.
 */
export class ObjectStorage {
  readonly bucket: string;
  private readonly client: S3Client;
  private readonly autoCreateBucket: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.bucket = env.AWS_S3_BUCKET ?? '';
    this.autoCreateBucket = env.S3_AUTO_CREATE_BUCKET === 'true';
    this.client = new S3Client({
      region: env.AWS_REGION ?? 'ap-southeast-1',
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? { credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } }
        : {}),
      // Chỉ tính checksum khi API bắt buộc, để tương thích cả S3 giả lập.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  get configured(): boolean {
    return Boolean(this.bucket);
  }

  /** Kiểm tra bucket khi khởi động; chỉ tự tạo bucket khi bật S3_AUTO_CREATE_BUCKET (S3 giả lập ở máy dev). */
  async ensureBucket(): Promise<'ok' | 'created'> {
    if (!this.configured) throw new Error('AWS_S3_BUCKET chưa được cấu hình');
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return 'ok';
    } catch (error) {
      if (!this.autoCreateBucket) throw error;
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      return 'created';
    }
  }

  /** Kiểm tra truy cập bucket (màn giám sát hệ thống); không tự tạo bucket. */
  async healthy(): Promise<boolean> {
    if (!this.configured) return false;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }

  async put(key: string, body: Buffer, contentType: string, metadata: Record<string, string> = {}): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.length,
      CacheControl: 'private, max-age=31536000, immutable',
      // Metadata của S3 chỉ nhận ASCII: mã hóa URI các giá trị có dấu.
      Metadata: Object.fromEntries(Object.entries(metadata).map(([name, value]) => [name, encodeURIComponent(value)])),
    }));
  }

  async get(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error(`File rỗng: ${key}`);
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Xóa toàn bộ file dưới một tiền tố (chỉ dùng khi tạo lại dữ liệu demo ở máy dev). */
  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).flatMap((item) => (item.Key ? [{ Key: item.Key }] : []));
      if (keys.length) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
        deleted += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }
}

/** Khóa file ảnh bằng chứng: chỉ dùng id do hệ thống sinh, không dùng tên file người dùng gửi lên. */
/** Khóa S3 của ảnh chứng từ: <thư mục>/<id chứng từ>/<id ảnh>.<đuôi>. */
export function attachmentObjectKey(prefix: string, entityId: string, attachmentId: string, contentType: string): string {
  const extension = contentType === 'image/jpeg' ? 'jpg' : contentType === 'application/pdf' ? 'pdf' : contentType.replace('image/', '');
  return `${prefix}/${entityId}/${attachmentId}.${extension}`;
}

export function evidenceObjectKey(orderId: string, attachmentId: string, contentType: string): string {
  return attachmentObjectKey('sales-evidence', orderId, attachmentId, contentType);
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ObjectStorage } from './object-storage';

@Injectable()
export class ObjectStorageService extends ObjectStorage implements OnModuleInit {
  private readonly logger = new Logger('ObjectStorage');

  constructor() {
    super(process.env);
  }

  /** Không chặn API khởi động khi S3 lỗi: chỉ chức năng tải ảnh bằng chứng bị ảnh hưởng (trả lỗi 503) và được ghi log rõ. */
  async onModuleInit(): Promise<void> {
    if (!this.configured) {
      this.logger.warn('AWS_S3_BUCKET chưa cấu hình — chưa tải được ảnh bằng chứng đối chiếu');
      return;
    }
    try {
      const result = await this.ensureBucket();
      this.logger.log(`S3 bucket "${this.bucket}" ${result === 'created' ? 'đã được tạo (S3 giả lập)' : 'sẵn sàng'}`);
    } catch (error) {
      this.logger.error(`Không truy cập được S3 bucket "${this.bucket}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

import { Controller, Get, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Db } from 'mongodb';
import { Roles, RootOnly } from '../../common/roles.decorator';
import { MONGO_DATABASE } from '../../common/tokens';

/** Trạng thái tích hợp (thiết lập hệ thống) — chỉ quản trị gốc. */
@RootOnly()
@Roles('ADMIN')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly config: ConfigService,
    @Inject(MONGO_DATABASE) private readonly db: Db,
  ) {}

  @Get('misa/status')
  async misaStatus() {
    const pending = await this.db.collection('outbox_events').countDocuments({
      destination: 'MISA',
      status: { $in: ['PENDING', 'RETRY', 'DEAD_LETTER'] },
    });
    return {
      configured: Boolean(this.config.get<string>('MISA_APP_ID') && this.config.get<string>('MISA_ACCESS_CODE')),
      mode: 'PHASE_2_ADAPTER',
      baseUrl: this.config.get<string>('MISA_BASE_URL') ?? 'https://actapp.misa.vn',
      pendingEvents: pending,
      sourceOfTruth: { operations: 'INOXPRAN_ERP', statutoryAccounting: 'MISA_AMIS' },
    };
  }
}

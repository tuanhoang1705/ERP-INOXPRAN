import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Db } from 'mongodb';
import { MONGO_DATABASE } from '../../common/tokens';
import { Public } from '../../common/public.decorator';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(@Inject(MONGO_DATABASE) private readonly db: Db) {}

  @Public()
  @Get()
  async health() {
    try {
      await this.db.command({ ping: 1 });
      return { status: 'ok', database: 'connected', timestamp: new Date().toISOString() };
    } catch {
      throw new ServiceUnavailableException({ code: 'DATABASE_UNAVAILABLE', message: 'Cơ sở dữ liệu chưa sẵn sàng' });
    }
  }
}

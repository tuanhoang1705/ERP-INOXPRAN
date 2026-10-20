import { Module } from '@nestjs/common';
import { ReceivablesController } from './receivables.controller';
import { ReceivablesService } from './receivables.service';
import { SegmentsController } from './segments.controller';
import { SegmentsService } from './segments.service';

@Module({
  controllers: [ReceivablesController, SegmentsController],
  providers: [ReceivablesService, SegmentsService],
})
export class ReceivablesModule {}

import { Module } from '@nestjs/common';
import { HistoryEditService } from './history-edit.service';
import { ReceivablesController } from './receivables.controller';
import { ReceivablesService } from './receivables.service';
import { SegmentsController } from './segments.controller';
import { SegmentsService } from './segments.service';

@Module({
  controllers: [ReceivablesController, SegmentsController],
  providers: [ReceivablesService, SegmentsService, HistoryEditService],
})
export class ReceivablesModule {}

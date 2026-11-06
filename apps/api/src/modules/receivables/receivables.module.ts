import { Module } from '@nestjs/common';
import { HistoryEditService } from './history-edit.service';
import { ReceivablesController } from './receivables.controller';
import { ReceivablesService } from './receivables.service';
import { SegmentsController } from './segments.controller';
import { SegmentsService } from './segments.service';

@Module({
  controllers: [ReceivablesController, SegmentsController],
  providers: [ReceivablesService, SegmentsService, HistoryEditService],
  // Sửa phiếu BH / phí bảo hành làm tổng nhỏ hơn số đã thu → xếp lại phần thu theo khách thành khách trả trước (06/11/2026).
  exports: [HistoryEditService],
})
export class ReceivablesModule {}

import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { InventoryReportsService } from './inventory-reports.service';
import { StockReturnsService } from './stock-returns.service';
import { StockCountsController } from './stock-counts.controller';
import { StockCountsService } from './stock-counts.service';
import { StockReturnPrintController } from './stock-return-print.controller';

@Module({
  controllers: [InventoryController, StockCountsController, StockReturnPrintController],
  providers: [InventoryService, InventoryReportsService, StockReturnsService, StockCountsService],
  exports: [InventoryService],
})
export class InventoryModule {}

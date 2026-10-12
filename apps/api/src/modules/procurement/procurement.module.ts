import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { ProcurementController } from './procurement.controller';
import { ImportShipmentsService } from './import-shipments.service';
import { ProcurementService } from './procurement.service';

@Module({
  imports: [InventoryModule],
  controllers: [ProcurementController],
  providers: [ProcurementService, ImportShipmentsService],
})
export class ProcurementModule {}

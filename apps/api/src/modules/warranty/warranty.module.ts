import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { WarrantyController } from './warranty.controller';
import { WarrantyFaultCodesService } from './warranty-fault-codes.service';
import { WarrantyService } from './warranty.service';

@Module({ imports: [InventoryModule], controllers: [WarrantyController], providers: [WarrantyService, WarrantyFaultCodesService], exports: [WarrantyService] })
export class WarrantyModule {}

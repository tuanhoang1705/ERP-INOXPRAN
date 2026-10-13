import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PriceOverridesController } from './price-overrides.controller';
import { PriceOverridesService } from './price-overrides.service';
import { PricingService } from './pricing.service';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [InventoryModule],
  controllers: [SalesController, PriceOverridesController],
  providers: [PricingService, SalesService, PriceOverridesService],
  exports: [SalesService],
})
export class SalesModule {}

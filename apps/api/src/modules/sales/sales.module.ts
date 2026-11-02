import { SalesChangeRequestsController } from './sales-change-requests.controller';
import { SalesChangeRequestsService } from './sales-change-requests.service';
import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PriceOverridesController } from './price-overrides.controller';
import { PriceOverridesService } from './price-overrides.service';
import { PricingService } from './pricing.service';
import { CustomerPricesController } from './customer-prices.controller';
import { CustomerPricesService } from './customer-prices.service';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({
  imports: [InventoryModule],
  controllers: [SalesController, PriceOverridesController, SalesChangeRequestsController, CustomerPricesController],
  providers: [PricingService, SalesService, PriceOverridesService, SalesChangeRequestsService, CustomerPricesService],
  exports: [SalesService],
})
export class SalesModule {}

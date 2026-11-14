import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { MasterDataService } from './master-data.service';
import { PriceListService } from './price-list.service';
import { PriceCatalogController } from './price-catalog.controller';
import { PriceCatalogGuard } from './price-catalog.guard';
import { PriceCatalogService } from './price-catalog.service';
import { ReferenceController } from './reference.controller';
import { TerritoriesService } from './territories.service';

@Module({
  controllers: [CatalogController, ReferenceController, PriceCatalogController],
  providers: [CatalogService, MasterDataService, TerritoriesService, PriceListService, PriceCatalogGuard, PriceCatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}

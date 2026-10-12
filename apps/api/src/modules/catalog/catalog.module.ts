import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { MasterDataService } from './master-data.service';
import { ReferenceController } from './reference.controller';

@Module({
  controllers: [CatalogController, ReferenceController],
  providers: [CatalogService, MasterDataService],
  exports: [CatalogService],
})
export class CatalogModule {}

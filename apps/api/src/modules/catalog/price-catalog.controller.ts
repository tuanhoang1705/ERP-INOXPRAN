import { Controller, Get, Header, Param, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/public.decorator';
import { PriceCatalogGuard } from './price-catalog.guard';
import { PriceCatalogService } from './price-catalog.service';

@ApiTags('Read-only price app')
@Public()
@UseGuards(PriceCatalogGuard)
@Controller('price-catalog')
export class PriceCatalogController {
  constructor(private readonly catalog: PriceCatalogService) {}

  @Get('price-list')
  @Header('Cache-Control', 'no-store')
  priceList() { return this.catalog.priceList(); }

  @Get('promotions')
  @Header('Cache-Control', 'no-store')
  promotions() { return this.catalog.promotions(); }

  @Get('attachments/products/:productId/:imageId')
  @Header('Cache-Control', 'private, max-age=300')
  @Header('Content-Security-Policy', "default-src 'none'")
  async image(@Param('productId') productId: string, @Param('imageId') imageId: string) {
    const image = await this.catalog.image(productId, imageId);
    return new StreamableFile(image.data, { type: image.contentType, disposition: 'inline', length: image.data.length });
  }
}

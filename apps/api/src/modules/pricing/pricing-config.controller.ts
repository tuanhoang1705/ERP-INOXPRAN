import { Body, Controller, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PRICING_EDITOR_ROLES, PricingPolicyInputSchema, PromotionInputSchema, UpdatePromotionSchema } from '@inoxpran/contracts';
import type { AuthenticatedRequest } from '../../common/request-context';
import { Roles } from '../../common/roles.decorator';
import { PricingConfigService } from './pricing-config.service';

/** Ghi cấu hình giá (xem: GET /pricing/policy, GET /promotions ở reference.controller). */
@ApiTags('Pricing')
@Controller()
export class PricingConfigController {
  constructor(private readonly pricing: PricingConfigService) {}

  @Roles(...PRICING_EDITOR_ROLES)
  @Patch('pricing/policy')
  updatePolicy(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.pricing.updatePolicy(PricingPolicyInputSchema.parse(body), request);
  }

  @Roles(...PRICING_EDITOR_ROLES)
  @Post('promotions')
  createPromotion(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.pricing.createPromotion(PromotionInputSchema.parse(body), request);
  }

  @Roles(...PRICING_EDITOR_ROLES)
  @Patch('promotions/:id')
  updatePromotion(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.pricing.updatePromotion(id, UpdatePromotionSchema.parse(body), request);
  }

  @Roles(...PRICING_EDITOR_ROLES)
  @Post('promotions/:id/stop')
  @HttpCode(200)
  stopPromotion(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.pricing.setPromotionStatus(id, 'INACTIVE', request);
  }

  @Roles(...PRICING_EDITOR_ROLES)
  @Post('promotions/:id/resume')
  @HttpCode(200)
  resumePromotion(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.pricing.setPromotionStatus(id, 'ACTIVE', request);
  }
}

import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiTags } from '@nestjs/swagger';
import {
  ConvertPartnerSchema,
  CreatePartnerSchema,
  CreateProductSchema,
  CreateWarehouseSchema,
  EmployeeInputSchema,
  LocationInputSchema,
  ProductCategoryInputSchema,
  RegionInputSchema,
  SetEmployeeTerritoriesSchema,
  UpdatePartnerSchema,
  UpdateProductSchema,
  UpdateWarehouseSchema,
} from '@inoxpran/contracts';
import { z } from 'zod';
import { pageRequest } from '../../common/paging';
import { onlyProvided } from '../../common/patch';
import { Roles, RootOnly } from '../../common/roles.decorator';
import type { AuthenticatedRequest } from '../../common/request-context';
import { CatalogService } from './catalog.service';
import { MasterDataService } from './master-data.service';
import { TerritoriesService } from './territories.service';
import { PARTNER_CREATE_ROLES, PARTNER_MANAGER_ROLES, PRODUCT_CREATE_ROLES, PRODUCT_EDITOR_ROLES, SALES_STRUCTURE_ROLES, SUPPLIER_MANAGER_ROLES, WAREHOUSE_EDITOR_ROLES } from './partner-access';

const UpdateCategorySchema = ProductCategoryInputSchema.partial().extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional() });
const UpdateLocationSchema = LocationInputSchema.omit({ warehouseId: true }).partial();
const UpdateRegionSchema = RegionInputSchema.omit({ code: true }).partial();
const UpdateEmployeeSchema = EmployeeInputSchema.partial();

/** Danh mục: sản phẩm, nhóm hàng, đối tác, kho, vị trí lưu, khu vực, nhân viên kinh doanh. */
@ApiTags('Catalog')
@Controller()
export class CatalogController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly master: MasterDataService,
    private readonly territories: TerritoriesService,
  ) {}

  // ---------- sản phẩm & nhóm hàng ----------

  @Get('products')
  products(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('categoryId') categoryId?: string,
    @Query('availability') availability?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.catalog.listProducts({ search, status, categoryId, availability, from, to }, pageRequest(page, pageSize));
  }

  @Get('products/:id')
  product(@Param('id') id: string) {
    return this.catalog.getProduct(id);
  }

  @Get('products/:id/overview')
  productOverview(@Param('id') id: string) {
    return this.catalog.productOverview(id);
  }

  @Roles(...PRODUCT_CREATE_ROLES)
  @Post('products')
  createProduct(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.catalog.createProduct(CreateProductSchema.parse(body), request);
  }

  @Roles(...PRODUCT_EDITOR_ROLES)
  @Patch('products/:id')
  updateProduct(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = UpdateProductSchema.parse(body);
    return this.master.updateProduct(id, { ...onlyProvided(body, input), version: input.version }, request);
  }

  /** Xóa mã chưa phát sinh chứng từ; `purge=1` (chỉ quản trị gốc) gỡ hẳn mã chỉ có tồn đầu kỳ nhập từ Excel (CAT-PURGE-01). */
  @Roles(...PRODUCT_EDITOR_ROLES)
  @Delete('products/:id')
  async deleteProduct(@Param('id') id: string, @Req() request: AuthenticatedRequest, @Query('purge') purge: string | undefined, @Res({ passthrough: true }) reply: FastifyReply) {
    if (purge === '1' || purge === 'true') {
      if (!request.user.root) throw new ForbiddenException({ code: 'ROOT_ONLY', message: 'Chỉ quản trị gốc được gỡ hẳn mã hàng kèm tồn đầu kỳ' });
      return this.master.purgeProduct(id, request);
    }
    await this.master.deleteProduct(id, request);
    reply.status(204);
    return undefined;
  }

  /** Quản trị gốc xem trước / gỡ hẳn cả nhóm hàng (mã chỉ có tồn đầu kỳ nhập từ Excel — CAT-PURGE-01). */
  @RootOnly()
  @Get('product-categories/:id/purge-preview')
  purgePreview(@Param('id') id: string) {
    return this.master.categoryPurgePreview(id);
  }

  @RootOnly()
  @Post('product-categories/:id/purge')
  purgeCategory(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const confirm = typeof (body as { confirm?: unknown } | null)?.confirm === 'string' ? String((body as { confirm: string }).confirm) : '';
    return this.master.purgeCategory(id, confirm, request);
  }

  /** `all=1`: gồm cả nhóm đã ngừng (màn hình quản lý nhóm hàng). */
  @Get('product-categories')
  categories(@Query('all') all?: string) {
    return this.master.listCategories(all === '1' || all === 'true');
  }

  @Roles(...PRODUCT_EDITOR_ROLES)
  @Post('product-categories')
  createCategory(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.master.createCategory(ProductCategoryInputSchema.parse(body), request);
  }

  @Roles(...PRODUCT_EDITOR_ROLES)
  @Patch('product-categories/:id')
  updateCategory(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.master.updateCategory(id, onlyProvided(body, UpdateCategorySchema.parse(body)), request);
  }

  @Roles(...PRODUCT_EDITOR_ROLES)
  @Delete('product-categories/:id')
  @HttpCode(204)
  deleteCategory(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.master.deleteCategory(id, request);
  }

  // ---------- đối tác ----------

  @Get('partners')
  partners(
    @Query('kind') kind?: string, @Query('search') search?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('stage') stage?: string,
    @Query('from') from?: string, @Query('to') to?: string,
  ) {
    return this.catalog.listPartners(kind, search, pageRequest(page, pageSize), stage, from, to);
  }

  @Get('partners/:id')
  partner(@Param('id') id: string) {
    return this.catalog.getPartner(id);
  }

  /** Khách "cơ hội" → khách chính thức (gán cấp giá); quyền kiểm tra trong service. */
  @Roles(...PARTNER_MANAGER_ROLES)
  @Post('partners/:id/convert')
  convertPartner(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.master.convertPartner(id, ConvertPartnerSchema.parse(body), request);
  }

  @Roles(...PARTNER_CREATE_ROLES)
  @Post('partners')
  createPartner(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.catalog.createPartner(CreatePartnerSchema.parse(body), request);
  }

  /** Quyền theo loại đối tác và quyền đổi hạn mức công nợ kiểm tra trong service (NVKD: chỉ hồ sơ khách cơ hội). */
  @Roles(...SUPPLIER_MANAGER_ROLES, 'ACCOUNTANT', 'SALES')
  @Patch('partners/:id')
  updatePartner(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = UpdatePartnerSchema.parse(body);
    return this.master.updatePartner(id, { ...onlyProvided(body, input), version: input.version }, request);
  }

  @Roles(...SUPPLIER_MANAGER_ROLES)
  @Delete('partners/:id')
  @HttpCode(204)
  deletePartner(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.master.deletePartner(id, request);
  }

  // ---------- kho & vị trí lưu ----------

  @Get('warehouses')
  warehouses() {
    return this.master.listWarehouses();
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post('warehouses')
  createWarehouse(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.catalog.createWarehouse(CreateWarehouseSchema.parse(body), request);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Patch('warehouses/:id')
  updateWarehouse(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const input = UpdateWarehouseSchema.parse(body);
    return this.master.updateWarehouse(id, { ...onlyProvided(body, input), version: input.version }, request);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Delete('warehouses/:id')
  @HttpCode(204)
  deleteWarehouse(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.master.deleteWarehouse(id, request);
  }

  @Get('locations')
  locations(@Query('warehouseId') warehouseId?: string) {
    return this.master.listLocations(warehouseId);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Post('locations')
  createLocation(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.master.createLocation(LocationInputSchema.parse(body), request);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Patch('locations/:id')
  updateLocation(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.master.updateLocation(id, onlyProvided(body, UpdateLocationSchema.parse(body)), request);
  }

  @Roles(...WAREHOUSE_EDITOR_ROLES)
  @Delete('locations/:id')
  @HttpCode(204)
  deleteLocation(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.master.deleteLocation(id, request);
  }

  // ---------- khu vực & nhân viên kinh doanh (xem: reference.controller) ----------

  @Roles(...SALES_STRUCTURE_ROLES)
  @Post('regions')
  createRegion(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.master.createRegion(RegionInputSchema.parse(body), request);
  }

  @Roles(...SALES_STRUCTURE_ROLES)
  @Patch('regions/:id')
  updateRegion(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.master.updateRegion(id, onlyProvided(body, UpdateRegionSchema.parse(body)), request);
  }

  @Roles(...SALES_STRUCTURE_ROLES)
  @Delete('regions/:id')
  @HttpCode(204)
  deleteRegion(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.master.deleteRegion(id, request);
  }

  /** Tài khoản kinh doanh để liên kết với hồ sơ NVKD. */
  @Roles(...SALES_STRUCTURE_ROLES)
  @Get('employees/linkable-users')
  linkableUsers() {
    return this.master.linkableUsers();
  }

  @Roles(...SALES_STRUCTURE_ROLES)
  @Post('employees')
  createEmployee(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.master.createEmployee(EmployeeInputSchema.parse(body), request);
  }

  @Roles(...SALES_STRUCTURE_ROLES)
  @Patch('employees/:id')
  updateEmployee(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.master.updateEmployee(id, onlyProvided(body, UpdateEmployeeSchema.parse(body)), request);
  }

  // ---------- phân vùng NVKD theo tỉnh cũ (PV-01, 30/10/2026) ----------

  /** Bảng phân vùng: dùng ở form khách (tự điền NVKD) và trang Phân vùng NVKD. */
  @Get('territories')
  listTerritories() {
    return this.territories.list();
  }

  @Roles(...SALES_STRUCTURE_ROLES)
  @Put('employees/:id/territories')
  setTerritories(@Param('id') id: string, @Body() body: unknown, @Req() request: AuthenticatedRequest) {
    return this.territories.setForEmployee(id, SetEmployeeTerritoriesSchema.parse(body), request);
  }

  @Roles(...SALES_STRUCTURE_ROLES)
  @Get('territories/mismatches')
  territoryMismatches() {
    return this.territories.mismatches();
  }

  /** Chuyển khách lệch vùng về NVKD phụ trách vùng; bỏ trống danh sách = mọi khách lệch không có ngoại lệ. */
  @Roles(...SALES_STRUCTURE_ROLES)
  @Post('territories/mismatches/fix')
  fixTerritoryMismatches(@Body() body: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = z.object({ partnerIds: z.array(z.string()).max(1000).optional() }).parse(body ?? {});
    return this.territories.fixMismatches(parsed.partnerIds, request);
  }

  @Roles(...SALES_STRUCTURE_ROLES)
  @Delete('employees/:id')
  @HttpCode(204)
  deleteEmployee(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.master.deleteEmployee(id, request);
  }
}

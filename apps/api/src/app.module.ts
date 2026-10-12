import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { validateEnvironment } from './config/env';
import { CommonModule } from './common/common.module';
import { CsrfGuard } from './common/csrf.guard';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { MongoModule } from './common/mongo.module';
import { RolesGuard } from './common/roles.guard';
import { AuditModule } from './modules/audit/audit.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { HealthModule } from './modules/health/health.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { ProcurementModule } from './modules/procurement/procurement.module';
import { ReceivablesModule } from './modules/receivables/receivables.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SalesModule } from './modules/sales/sales.module';
import { WarrantyModule } from './modules/warranty/warranty.module';
import { AdminModule } from './modules/admin/admin.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { CrmModule } from './modules/crm/crm.module';
import { HistoryModule } from './modules/history/history.module';
import { PricingModule } from './modules/pricing/pricing.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'], validate: validateEnvironment }),
    MongoModule,
    CommonModule,
    AuthModule,
    HealthModule,
    CatalogModule,
    InventoryModule,
    SalesModule,
    ProcurementModule,
    ReceivablesModule,
    DashboardModule,
    ReportsModule,
    AuditModule,
    ApprovalsModule,
    IntegrationsModule,
    NotificationsModule,
    WarrantyModule,
    AdminModule,
    AttachmentsModule,
    CrmModule,
    HistoryModule,
    PricingModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}

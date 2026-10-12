import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { AdminController } from './admin.controller';
import { ImportController } from './import/import.controller';
import { ImportService } from './import/import.service';
import { SystemService } from './system.service';
import { UsersAdminService } from './users.service';

@Module({ imports: [InventoryModule], controllers: [AdminController, ImportController], providers: [UsersAdminService, SystemService, ImportService] })
export class AdminModule {}

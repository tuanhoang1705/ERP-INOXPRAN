import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReturnsReportService } from './returns-report.service';

@Module({ controllers: [ReportsController], providers: [ReportsService, ReturnsReportService], exports: [ReturnsReportService] })
export class ReportsModule {}

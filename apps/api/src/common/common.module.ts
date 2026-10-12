import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { DatabaseIndexesService } from './database-indexes.service';
import { EvidenceIntakeService } from './evidence-intake.service';
import { IdempotencyService } from './idempotency.service';
import { MalwareScannerService } from './malware-scanner.service';
import { ObjectStorageService } from './object-storage.service';
import { OutboxService } from './outbox.service';
import { SequenceService } from './sequence.service';

@Global()
@Module({
  providers: [AuditService, IdempotencyService, OutboxService, SequenceService, DatabaseIndexesService, ObjectStorageService, MalwareScannerService, EvidenceIntakeService],
  exports: [AuditService, IdempotencyService, OutboxService, SequenceService, ObjectStorageService, MalwareScannerService, EvidenceIntakeService],
})
export class CommonModule {}

import { Module } from '@nestjs/common';
import { ImportControleur } from './import.controleur';
import { ImportService } from './import.service';

@Module({
  controllers: [ImportControleur],
  providers: [ImportService],
  exports: [ImportService],
})
export class ImportModule {}

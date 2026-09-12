import { Module } from '@nestjs/common';
import { RapportsControleur } from './rapports.controleur';
import { RapportsService } from './rapports.service';

@Module({
  controllers: [RapportsControleur],
  providers: [RapportsService],
})
export class RapportsModule {}

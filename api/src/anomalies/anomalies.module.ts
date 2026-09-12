import { Module } from '@nestjs/common';
import { AnomaliesControleur } from './anomalies.controleur';
import { AnomaliesService } from './anomalies.service';

@Module({
  controllers: [AnomaliesControleur],
  providers: [AnomaliesService],
})
export class AnomaliesModule {}

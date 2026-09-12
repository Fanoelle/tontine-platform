import { Module } from '@nestjs/common';
import { HistoriqueControleur } from './historique.controleur';
import { HistoriqueService } from './historique.service';

@Module({
  controllers: [HistoriqueControleur],
  providers: [HistoriqueService],
  exports: [HistoriqueService],
})
export class HistoriqueModule {}

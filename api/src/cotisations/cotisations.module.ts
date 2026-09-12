import { Module } from '@nestjs/common';
import { CotisationsControleur } from './cotisations.controleur';
import { CotisationsService } from './cotisations.service';

@Module({
  controllers: [CotisationsControleur],
  providers: [CotisationsService],
})
export class CotisationsModule {}

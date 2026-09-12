import { Module } from '@nestjs/common';
import { AidesControleur } from './aides.controleur';
import { AidesService } from './aides.service';

@Module({
  controllers: [AidesControleur],
  providers: [AidesService],
})
export class AidesModule {}

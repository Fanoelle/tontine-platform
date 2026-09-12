import { Module } from '@nestjs/common';
import { PretsControleur } from './prets.controleur';
import { PretsService } from './prets.service';

@Module({
  controllers: [PretsControleur],
  providers: [PretsService],
})
export class PretsModule {}

import { Module } from '@nestjs/common';
import { GroupesControleur } from './groupes.controleur';
import { GroupesService } from './groupes.service';

@Module({
  controllers: [GroupesControleur],
  providers: [GroupesService],
})
export class GroupesModule {}

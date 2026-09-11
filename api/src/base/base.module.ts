/**
 * Module global d'accès à la base.
 *
 * @Global parce que tout service métier a besoin de la base. L'alternative —
 * réimporter BaseModule dans chacun — n'apporterait aucune isolation réelle et
 * ajouterait une ligne à chaque module.
 */
import { Global, Module } from '@nestjs/common';
import { BaseService } from './base.service';

@Global()
@Module({
  providers: [BaseService],
  exports: [BaseService],
})
export class BaseModule {}

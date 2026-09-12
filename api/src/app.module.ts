/**
 * Module racine.
 *
 * LES DEUX GARDES SONT ENREGISTRÉES GLOBALEMENT, dans cet ordre : JetonGarde
 * authentifie et reconstitue la session, RolesGarde vérifie l'habilitation. Cet
 * ordre n'est pas cosmétique — RolesGarde lit `requete.session`, que JetonGarde
 * vient de poser.
 *
 * C'est cet enregistrement global qui donne à N-SEC-04 sa propriété : une route
 * nouvellement écrite est protégée sans que son auteur ait rien à faire.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthentificationModule } from './authentification/authentification.module';
import { JetonGarde } from './authentification/jeton.garde';
import { RolesGarde } from './authentification/roles.garde';
import { BaseModule } from './base/base.module';
import { AidesModule } from './aides/aides.module';
import { AnomaliesModule } from './anomalies/anomalies.module';
import { CotisationsModule } from './cotisations/cotisations.module';
import { GroupesModule } from './groupes/groupes.module';
import { PretsModule } from './prets/prets.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BaseModule,
    AuthentificationModule,
    CotisationsModule,
    GroupesModule,
    PretsModule,
    AidesModule,
    AnomaliesModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JetonGarde },
    { provide: APP_GUARD, useClass: RolesGarde },
  ],
})
export class AppModule {}

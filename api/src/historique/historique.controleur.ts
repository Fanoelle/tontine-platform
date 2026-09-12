import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Roles } from '../authentification/roles.decorator';
import { SessionCourante, type Session } from '../authentification/session';
import { HistoriqueService } from './historique.service';
import { Limite } from '../commun/limite.decorateur';

@Controller('historique')
export class HistoriqueControleur {
  constructor(private readonly service: HistoriqueService) {}

  /**
   * L'historique du groupe, ouvert à TOUT MEMBRE authentifié.
   *
   * C'est un choix, et il découle du but même de la plateforme : restituer une
   * confiance vérifiable. Un historique réservé au bureau reproduirait
   * l'opacité qu'on cherche à abolir — le membre qui conteste une dispense doit
   * pouvoir lire qui l'a accordée, et pourquoi.
   *
   * Le journal comptable, lui, reste réservé : il expose le mécanisme en
   * partie double, que N-USG-05 tient hors de portée des membres.
   */
  @Get()
  lister(
    @SessionCourante() session: Session,
    // `limite` avant `categorie` : un paramètre obligatoire ne peut pas suivre
    // un paramètre optionnel en TypeScript, et le décorateur fournit toujours
    // une valeur — par défaut s'il le faut.
    @Limite() limite: number,
    @Query('categorie') categorie?: string,
  ) {
    return this.service.lister(session, categorie, limite);
  }

  @Get('synthese')
  synthese(@SessionCourante() session: Session) {
    return this.service.synthese(session);
  }

  /**
   * Ce qu'un membre donné a fait — réservé au bureau.
   *
   * Donner à chacun l'historique de ses pairs transformerait un outil de
   * contrôle mutuel en instrument de surveillance réciproque.
   */
  @Get('membre/:id')
  @Roles('PRESIDENT', 'COMMISSAIRE', 'TRESORIER')
  parAuteur(
    @SessionCourante() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Limite() limite: number,
  ) {
    return this.service.parAuteur(session, id, limite);
  }

  /**
   * Journal d'accès technique — réservé au commissaire aux comptes.
   *
   * Il contient les tentatives REFUSÉES, qui relèvent du contrôle et non de la
   * gestion courante. Les exposer au trésorier reviendrait à lui donner la
   * trace de ses propres refus d'habilitation, ce qui n'a pas de sens.
   */
  @Get('acces')
  @Roles('COMMISSAIRE')
  acces(
    @SessionCourante() session: Session,
    @Limite() limite: number,
  ) {
    return this.service.acces(session, limite);
  }
}

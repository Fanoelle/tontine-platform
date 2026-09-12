import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Roles } from '../authentification/roles.decorator';
import { SessionCourante, type Session } from '../authentification/session';
import { NotificationsService } from './notifications.service';

class AccuseDto {
  @IsUUID()
  cotisation_id!: string;
}

class BalayageDto {
  // Entre 1 et 15 jours : au-delà, un rappel arrive si tôt qu'il est oublié
  // avant l'échéance, et le membre finit par ne plus les lire.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(15, { message: 'Un rappel plus de 15 jours à l’avance est inutile' })
  jours_avant?: number;
}

@Controller('notifications')
export class NotificationsControleur {
  constructor(private readonly service: NotificationsService) {}

  /**
   * La file du groupe — réservée au bureau.
   *
   * Elle contient le texte des messages adressés à chacun : l'ouvrir à tous
   * reviendrait à laisser lire le courrier des autres.
   */
  @Get()
  @Roles('TRESORIER', 'PRESIDENT', 'COMMISSAIRE')
  lister(
    @SessionCourante() session: Session,
    @Query('statut') statut?: string,
  ) {
    return this.service.lister(session, statut);
  }

  /**
   * Ce que le membre a lui-même reçu.
   *
   * Accessible à tout membre authentifié : c'est sa propre trace. Savoir qu'on
   * a été prévenu — ou qu'on ne l'a pas été — fait partie de ce que la
   * plateforme doit rendre vérifiable.
   */
  @Get('mes-notifications')
  mesNotifications(@SessionCourante() session: Session) {
    return this.service.mesNotifications(session);
  }

  /** F-NOT-01, F-COT-06, F-NOT-03 — met en file rappels et alertes. */
  @Post('balayage')
  @Roles('TRESORIER', 'PRESIDENT')
  @HttpCode(HttpStatus.OK)
  balayer(
    @SessionCourante() session: Session,
    @Body() dto: BalayageDto,
  ) {
    return this.service.balayer(session, dto.jours_avant ?? 3);
  }

  /** F-NOT-02 — accusé de réception d'un versement. */
  @Post('accuse-versement')
  @Roles('TRESORIER')
  @HttpCode(HttpStatus.OK)
  accuser(
    @SessionCourante() session: Session,
    @Body() dto: AccuseDto,
  ) {
    return this.service.accuserVersement(session, dto.cotisation_id);
  }

  /**
   * Vide la file des messages dont l'heure est venue.
   *
   * LE PLANIFICATEUR FAIT DÉSORMAIS CELA TOUT SEUL (planificateur.service.ts).
   * Cette route reste, et ce n'est pas une redondance : le trésorier qui vient
   * de saisir dix versements veut voir partir les accusés sans attendre le
   * prochain passage. Rejouer un balayage est sans risque — la déduplication
   * est portée par des index uniques en base, pas par la cadence des appels.
   */
  @Post('expedition')
  @Roles('TRESORIER', 'PRESIDENT')
  @HttpCode(HttpStatus.OK)
  expedier(@SessionCourante() session: Session) {
    return this.service.expedierEnAttente(session);
  }
}

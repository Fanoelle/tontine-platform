import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { Roles } from '../authentification/roles.decorator';
import { SessionCourante, type Session } from '../authentification/session';
import { AnomaliesService } from './anomalies.service';

class LeveeDto {
  // Un motif de vingt caractères au moins : une levée motivée par « ok » ou
  // « vu » vide F-ANO-08 de son sens. La levée fait partie de la piste d'audit,
  // et un motif indigent la rend inexploitable des mois plus tard.
  @IsString()
  @MinLength(20, {
    message:
      'Le motif de levée doit être explicite — au moins 20 caractères. ' +
      'Il restera au dossier et doit rester compréhensible plus tard.',
  })
  motif!: string;
}

@Controller('anomalies')
export class AnomaliesControleur {
  constructor(private readonly service: AnomaliesService) {}

  /**
   * F-TDB-04 — réservé au bureau et au commissaire.
   *
   * Un membre ordinaire n'a pas à voir la liste des écarts constatés sur ses
   * pairs : ce serait transformer un outil de contrôle mutuel en instrument de
   * surveillance réciproque.
   */
  @Get()
  @Roles('COMMISSAIRE', 'TRESORIER', 'PRESIDENT')
  ouvertes(@SessionCourante() session: Session) {
    return this.service.ouvertes(session);
  }

  @Get('levees')
  @Roles('COMMISSAIRE', 'TRESORIER', 'PRESIDENT')
  levees(@SessionCourante() session: Session) {
    return this.service.levees(session);
  }

  /** Déclenchement manuel du balayage, en complément de la tâche de fond. */
  @Post('balayage')
  @Roles('COMMISSAIRE', 'TRESORIER', 'PRESIDENT')
  @HttpCode(HttpStatus.OK)
  balayer(@SessionCourante() session: Session) {
    return this.service.balayer(session);
  }

  /**
   * F-ANO-08 — le trésorier peut lever une anomalie de gravité faible ou
   * moyenne ; la fonction SQL réserve les CRITIQUES au commissaire (F-ANO-09).
   */
  @Post(':id/levee')
  @Roles('COMMISSAIRE', 'TRESORIER')
  @HttpCode(HttpStatus.OK)
  lever(
    @SessionCourante() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LeveeDto,
  ) {
    return this.service.lever(session, id, dto.motif);
  }
}

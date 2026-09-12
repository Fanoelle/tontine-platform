/**
 * Routes des cotisations.
 *
 * AUCUNE ROUTE NE PORTE D'IDENTIFIANT DE GROUPE (N-SEC-03). Les adresses sont
 * `/cotisations`, jamais `/groupes/{id}/cotisations` : le groupe vient du jeton,
 * ce qui rend une fuite transversale structurellement impossible plutôt que
 * simplement évitée.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';
import { Roles } from '../authentification/roles.decorator';
import { SessionCourante, type Session } from '../authentification/session';
import { CotisationsService } from './cotisations.service';

const MOYENS = ['ESPECES', 'MOBILE_MONEY', 'VIREMENT', 'COMPENSATION'] as const;

class VersementDto {
  @IsUUID()
  echeance_id!: string;

  // Entier strictement positif : miroir de R-03 et de N-INT-03. Un flottant
  // serait refusé ici comme il le serait par la colonne BIGINT.
  @IsInt({ message: 'Le montant doit être un nombre entier de francs' })
  @IsPositive({ message: 'Le montant doit être strictement positif' })
  montant!: number;

  @IsISO8601({}, { message: 'La date doit être au format AAAA-MM-JJ' })
  date_versement!: string;

  @IsEnum(MOYENS, {
    message: `Le moyen de paiement doit être l'un de : ${MOYENS.join(', ')}`,
  })
  moyen!: string;

  @IsOptional()
  @IsString()
  reference_externe?: string;
}

class AnnulationDto {
  @IsString()
  @MinLength(10, {
    message: 'Le motif doit être explicite — au moins 10 caractères',
  })
  motif!: string;
}

class DispenseDto {
  @IsString()
  @MinLength(10, {
    message: 'Le motif doit être explicite — au moins 10 caractères',
  })
  motif!: string;
}

@Controller('cotisations')
export class CotisationsControleur {
  constructor(private readonly service: CotisationsService) {}

  /** F-COT-04 — liste des échéances non soldées. */
  @Get('impayes')
  @Roles('TRESORIER', 'PRESIDENT', 'COMMISSAIRE')
  impayes(
    @SessionCourante() session: Session,
    @Query('cycle_id') cycleId?: string,
  ) {
    return this.service.impayes(session, cycleId);
  }

  /** F-COT-02 — enregistre un versement. Trésorier uniquement (N-SEC-05). */
  @Post()
  @Roles('TRESORIER')
  enregistrer(
    @SessionCourante() session: Session,
    @Body() dto: VersementDto,
  ) {
    return this.service.enregistrer(
      session,
      dto.echeance_id,
      dto.montant,
      dto.date_versement,
      dto.moyen,
      dto.reference_externe,
    );
  }

  /** F-COT-05 — annule par écriture inverse. */
  @Post(':id/annulation')
  @Roles('TRESORIER')
  @HttpCode(HttpStatus.OK)
  annuler(
    @SessionCourante() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnnulationDto,
  ) {
    return this.service.annuler(session, id, dto.motif);
  }

  /** F-COT-07 — dispense. La fonction SQL exige en outre le rôle président. */
  @Post('echeances/:id/dispense')
  @Roles('PRESIDENT')
  @HttpCode(HttpStatus.OK)
  dispenser(
    @SessionCourante() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DispenseDto,
  ) {
    return this.service.dispenser(session, id, dto.motif);
  }

  /**
   * F-RAP-01 — relevé d'un membre.
   *
   * Aucun rôle exigé : tout membre authentifié y accède. Le cloisonnement par
   * groupe suffit ici, et restreindre empêcherait un membre de consulter sa
   * propre situation — ce que le cahier des charges lui accorde explicitement.
   */
  @Get('releve/:membre_id')
  releve(
    @SessionCourante() session: Session,
    @Param('membre_id', ParseUUIDPipe) membreId: string,
  ) {
    return this.service.releve(session, membreId);
  }
}

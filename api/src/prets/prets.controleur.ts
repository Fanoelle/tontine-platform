/**
 * Routes des prêts — F-PRE.
 *
 * Aucune ne porte d'identifiant de groupe : il vient du jeton (N-SEC-03).
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
} from '@nestjs/common';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { Roles } from '../authentification/roles.decorator';
import { SessionCourante, type Session } from '../authentification/session';
import { PretsService } from './prets.service';

const MOYENS = ['ESPECES', 'MOBILE_MONEY', 'VIREMENT', 'COMPENSATION'] as const;

class DemandePretDto {
  @IsInt({ message: 'Le montant doit être un nombre entier de francs' })
  @IsPositive({ message: 'Le montant doit être strictement positif' })
  montant!: number;

  @IsString()
  @MinLength(10, {
    message: 'Le motif doit être explicite — au moins 10 caractères',
  })
  motif!: string;

  // Borné à 36 : au-delà, l'échéancier dépasse la durée d'un cycle et le prêt
  // survivrait à la redistribution de fin de cycle, ce que le modèle ne prévoit
  // pas.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(36, { message: 'Un prêt ne peut excéder 36 échéances' })
  nombre_echeances?: number;

  @IsOptional()
  @IsUUID()
  emprunteur_id?: string;
}

class ApprobationDto {
  @IsInt({ message: 'Le montant doit être un nombre entier de francs' })
  @IsPositive()
  montant!: number;
}

class RefusDto {
  @IsString()
  @MinLength(10, {
    message: 'Un refus doit être motivé — au moins 10 caractères',
  })
  motif!: string;
}

class RemboursementDto {
  @IsInt()
  @Min(0)
  capital!: number;

  // L'intérêt est séparé du capital : il rémunère le groupe et va à un compte
  // de produit distinct. Les confondre masquerait ce que le prêt a rapporté.
  @IsInt()
  @Min(0)
  interet!: number;

  @IsISO8601({}, { message: 'La date doit être au format AAAA-MM-JJ' })
  date_versement!: string;

  @IsEnum(MOYENS, {
    message: `Le moyen doit être l'un de : ${MOYENS.join(', ')}`,
  })
  moyen!: string;
}

@Controller('prets')
export class PretsControleur {
  constructor(private readonly service: PretsService) {}

  /** F-RAP-04 — accessible à tout membre : chacun voit l'encours du groupe. */
  @Get()
  lister(@SessionCourante() session: Session) {
    return this.service.lister(session);
  }

  /** R-06 — ce que la caisse peut réellement prêter. */
  @Get('avoir-disponible')
  @Roles('PRESIDENT', 'TRESORIER', 'COMMISSAIRE')
  avoir(@SessionCourante() session: Session) {
    return this.service.avoirDisponible(session);
  }

  @Get(':id/echeancier')
  echeancier(
    @SessionCourante() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.echeancier(session, id);
  }

  /**
   * F-PRE-01 — aucun rôle exigé : tout membre peut demander un prêt. C'est le
   * président qui tranche, pas l'interface qui filtre.
   */
  @Post()
  demander(
    @SessionCourante() session: Session,
    @Body() dto: DemandePretDto,
  ) {
    return this.service.demander(
      session,
      dto.montant,
      dto.motif,
      dto.nombre_echeances ?? 1,
      dto.emprunteur_id,
    );
  }

  /** F-PRE-02 — la fonction SQL exige en outre le rôle président. */
  @Post(':id/approbation')
  @Roles('PRESIDENT')
  @HttpCode(HttpStatus.OK)
  approuver(
    @SessionCourante() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApprobationDto,
  ) {
    return this.service.approuver(session, id, dto.montant);
  }

  @Post(':id/refus')
  @Roles('PRESIDENT')
  @HttpCode(HttpStatus.OK)
  refuser(
    @SessionCourante() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefusDto,
  ) {
    return this.service.refuser(session, id, dto.motif);
  }

  /** F-PRE-04 — le trésorier encaisse, comme pour les cotisations. */
  @Post(':id/remboursement')
  @Roles('TRESORIER')
  @HttpCode(HttpStatus.OK)
  rembourser(
    @SessionCourante() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RemboursementDto,
  ) {
    return this.service.rembourser(
      session,
      id,
      dto.capital,
      dto.interet,
      dto.date_versement,
      dto.moyen,
    );
  }
}

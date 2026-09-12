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
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';
import { Roles } from '../authentification/roles.decorator';
import { SessionCourante, type Session } from '../authentification/session';
import { AidesService } from './aides.service';

class DemandeAideDto {
  @IsInt({ message: 'Le montant doit être un nombre entier de francs' })
  @IsPositive()
  montant!: number;

  // Le motif est ce sur quoi le groupe délibère : une demande d'aide sans
  // motif est indécidable.
  @IsString()
  @MinLength(10, {
    message: 'Le motif doit être explicite — au moins 10 caractères',
  })
  motif!: string;

  @IsOptional()
  @IsUUID()
  beneficiaire_id?: string;
}

class ApprobationAideDto {
  @IsInt()
  @IsPositive()
  montant!: number;
}

@Controller('aides')
export class AidesControleur {
  constructor(private readonly service: AidesService) {}

  @Get()
  lister(@SessionCourante() session: Session) {
    return this.service.lister(session);
  }

  /** F-AID-03 — consultative : elle éclaire la décision, ne la remplace pas. */
  @Get(':id/eligibilite')
  @Roles('PRESIDENT', 'TRESORIER', 'COMMISSAIRE')
  eligibilite(
    @SessionCourante() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.eligibilite(session, id);
  }

  /** F-AID-01 — tout membre peut solliciter le fonds. */
  @Post()
  demander(
    @SessionCourante() session: Session,
    @Body() dto: DemandeAideDto,
  ) {
    return this.service.demander(
      session,
      dto.montant,
      dto.motif,
      dto.beneficiaire_id,
    );
  }

  @Post(':id/approbation')
  @Roles('PRESIDENT')
  @HttpCode(HttpStatus.OK)
  approuver(
    @SessionCourante() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApprobationAideDto,
  ) {
    return this.service.approuver(session, id, dto.montant);
  }

  /** F-AID-02 — le trésorier verse, le président décide. Séparation voulue. */
  @Post(':id/versement')
  @Roles('TRESORIER')
  @HttpCode(HttpStatus.OK)
  verser(
    @SessionCourante() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.verser(session, id);
  }
}

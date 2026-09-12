import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Roles } from '../authentification/roles.decorator';
import { SessionCourante, type Session } from '../authentification/session';
import { RapportsService } from './rapports.service';

class LigneReleveDto {
  @IsString()
  @MinLength(1)
  reference!: string;

  @IsInt({ message: 'Le montant doit être un nombre entier de francs' })
  @IsPositive()
  montant!: number;

  @IsISO8601({}, { message: 'La date doit être au format AAAA-MM-JJ' })
  date_operation!: string;

  @IsOptional()
  @IsString()
  telephone?: string;

  @IsOptional()
  @IsString()
  libelle?: string;
}

class ImportReleveDto {
  @IsString()
  @MinLength(2)
  operateur!: string;

  @IsISO8601()
  periode_debut!: string;

  @IsISO8601()
  periode_fin!: string;

  // Borné à 5 000 lignes : au-delà, l'import doit passer par un traitement
  // différé plutôt que par une requête HTTP qui expirerait à mi-chemin et
  // laisserait un relevé partiel — donc un rapprochement faux.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000, {
    message: 'Un import est limité à 5 000 lignes',
  })
  @ValidateNested({ each: true })
  @Type(() => LigneReleveDto)
  lignes!: LigneReleveDto[];
}

class ReechelonnementDto {
  @IsInt()
  @Min(1)
  @Max(36, { message: 'Un échéancier ne peut excéder 36 échéances' })
  echeances!: number;

  @IsString()
  @MinLength(10, {
    message: 'Un rééchelonnement doit être motivé — au moins 10 caractères',
  })
  motif!: string;
}

@Controller()
export class RapportsControleur {
  constructor(private readonly service: RapportsService) {}

  /**
   * F-RAP-05 — rapport d'assemblée.
   *
   * Accessible à TOUT MEMBRE authentifié, et non au seul bureau : un rapport
   * d'assemblée est fait pour être lu devant le groupe. Le réserver au bureau
   * reproduirait l'opacité que la plateforme existe pour abolir.
   */
  @Get('rapport-assemblee')
  rapportAssemblee(
    @SessionCourante() session: Session,
    @Query('date') date?: string,
  ) {
    return this.service.rapportAssemblee(session, date);
  }

  /** F-RAP-06 — export du journal. */
  @Get('exports/journal.csv')
  @Roles('TRESORIER', 'PRESIDENT', 'COMMISSAIRE')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="journal.csv"')
  exporterJournal(
    @SessionCourante() session: Session,
    @Query('debut') debut?: string,
    @Query('fin') fin?: string,
  ) {
    return this.service.exporter(session, 'journal', debut, fin);
  }

  @Get('exports/membres.csv')
  @Roles('TRESORIER', 'PRESIDENT', 'COMMISSAIRE')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="membres.csv"')
  exporterMembres(@SessionCourante() session: Session) {
    return this.service.exporter(session, 'membres');
  }

  @Get('exports/rapport.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="rapport-assemblee.csv"')
  exporterRapport(
    @SessionCourante() session: Session,
    @Query('date') date?: string,
  ) {
    return this.service.exporter(session, 'rapport', date);
  }

  /** F-TRX-06 — relevés Mobile Money. */
  @Get('releves')
  @Roles('TRESORIER', 'PRESIDENT', 'COMMISSAIRE')
  releves(@SessionCourante() session: Session) {
    return this.service.releves(session);
  }

  @Post('releves')
  @Roles('TRESORIER')
  importerReleve(
    @SessionCourante() session: Session,
    @Body() dto: ImportReleveDto,
  ) {
    return this.service.importerReleve(
      session,
      dto.operateur,
      dto.periode_debut,
      dto.periode_fin,
      dto.lignes,
    );
  }

  /**
   * Le rapprochement est une LECTURE, d'où le GET : il ne crée rien, ne
   * corrige rien, et peut être rejoué autant de fois que nécessaire.
   */
  @Get('releves/:id/rapprochement')
  @Roles('TRESORIER', 'PRESIDENT', 'COMMISSAIRE')
  rapprocher(
    @SessionCourante() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.rapprocher(session, id);
  }

  /** F-EPA-03, F-EPA-04 — décompte de redistribution ASCA. */
  @Get('redistribution')
  @Roles('TRESORIER', 'PRESIDENT', 'COMMISSAIRE')
  redistribution(@SessionCourante() session: Session) {
    return this.service.decompteRedistribution(session);
  }

  /**
   * F-PRE-07 — rééchelonnement.
   *
   * LE CHEMIN EST `reechelonnements/:id` ET NON `prets/:id/reechelonnement` :
   * un chemin commençant par `prets/` depuis un contrôleur sans préfixe entre
   * en concurrence avec PretsControleur, déclaré sur `@Controller('prets')`.
   * Mieux vaut un chemin sans ambiguïté possible qu'un ordre d'enregistrement
   * dont dépendrait la résolution.
   *
   * La fonction SQL exige en outre le rôle président.
   */
  @Post('reechelonnements/:id')
  @Roles('PRESIDENT')
  @HttpCode(HttpStatus.OK)
  reechelonner(
    @SessionCourante() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReechelonnementDto,
  ) {
    return this.service.reechelonner(session, id, dto.echeances, dto.motif);
  }

  /** F-GRP-06 — archivage du groupe de la session. */
  @Post('archivage')
  @Roles('PRESIDENT')
  @HttpCode(HttpStatus.OK)
  archiver(@SessionCourante() session: Session) {
    return this.service.archiver(session);
  }
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Roles } from '../authentification/roles.decorator';
import { SessionCourante, type Session } from '../authentification/session';
import { ImportService } from './import.service';

/**
 * UN MÉGAOCTET DE PLAFOND. Un cahier de douze membres sur vingt-quatre mois
 * fait moins de trente kilo-octets ; le mégaoctet laisse une marge considérable
 * tout en empêchant qu'un fichier envoyé par erreur — une photo renommée, un
 * export complet de comptabilité — ne monopolise la mémoire du serveur.
 */
const TAILLE_MAXIMALE = 1_000_000;

class ApercuDto {
  @IsString()
  @MinLength(10, { message: 'Le fichier est vide ou tronqué' })
  @MaxLength(TAILLE_MAXIMALE, {
    message: 'Fichier trop volumineux — un cahier de tontine dépasse rarement '
      + 'quelques dizaines de kilo-octets',
  })
  contenu!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9]\d{0,3}$/, {
    message: 'L\'indicatif doit être au format international, par exemple +237',
  })
  indicatif_defaut?: string;
}

class ImportDto extends ApercuDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  source!: string;

  @IsInt()
  @Min(1, { message: 'Le montant de cotisation doit être positif' })
  montant_cotisation!: number;

  @IsIn(['HEBDOMADAIRE', 'QUINZAINE', 'MENSUELLE', 'TRIMESTRIELLE'])
  periodicite!: string;

  @IsDateString(
    {},
    { message: 'La date de début doit être au format AAAA-MM-JJ' },
  )
  date_debut!: string;
}

@Controller('import')
export class ImportControleur {
  constructor(private readonly service: ImportService) {}

  /**
   * Ce que l'import ferait, sans rien écrire.
   *
   * SÉPARÉE DE L'IMPORT LUI-MÊME, et c'est la pièce maîtresse de cette
   * fonctionnalité. Le journal comptable étant immuable, un import regretté ne
   * se défait pas : il faut détruire le groupe et recommencer. Voir avant de
   * valider est la seule protection réelle de l'utilisateur.
   */
  @Post('apercu')
  @Roles('PRESIDENT', 'TRESORIER')
  @HttpCode(HttpStatus.OK)
  apercu(@Body() dto: ApercuDto) {
    return this.service.apercu(dto.contenu, dto.indicatif_defaut);
  }

  /**
   * Applique l'import — réservé au président et au trésorier.
   *
   * Reprendre un cahier fixe l'ordre de passage et l'historique des
   * versements : c'est un acte de gouvernance, pas une saisie courante.
   */
  @Post()
  @Roles('PRESIDENT', 'TRESORIER')
  @HttpCode(HttpStatus.CREATED)
  appliquer(@SessionCourante() session: Session, @Body() dto: ImportDto) {
    return this.service.appliquer(
      session,
      dto.contenu,
      dto.source,
      dto.montant_cotisation,
      dto.periodicite,
      dto.date_debut,
      dto.indicatif_defaut,
    );
  }

  /**
   * Les imports déjà faits — ouvert à tout membre.
   *
   * Savoir qu'une partie de l'historique vient d'un cahier papier plutôt que
   * d'une saisie contrôlée est une information qui appartient au groupe, pas
   * au seul bureau : elle dit quelle confiance accorder aux chiffres anciens.
   */
  @Get()
  historique(@SessionCourante() session: Session) {
    return this.service.historique(session);
  }
}

/**
 * Routes d'authentification.
 *
 * `/connexion` est l'une des très rares routes @Public() : elle doit être
 * atteignable sans jeton, puisqu'elle en délivre un.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import { IsString, Matches, MinLength } from 'class-validator';
import {
  AuthentificationService,
  type ResultatConnexion,
} from './authentification.service';
import { Public } from './public.decorator';
import { SessionCourante, type Session } from './session';

class ConnexionDto {
  /** Format international strict, identique à la contrainte SQL (R-10). */
  @IsString()
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message:
      'Le téléphone doit être au format international, par exemple +237690110001',
  })
  telephone!: string;

  @IsString()
  @MinLength(8, {
    message: 'Le mot de passe comporte au moins 8 caractères',
  })
  mot_de_passe!: string;
}

@Controller('authentification')
export class AuthentificationControleur {
  constructor(private readonly service: AuthentificationService) {}

  @Public()
  @Post('connexion')
  // 200 et non 201 : une connexion ne crée pas de ressource.
  @HttpCode(HttpStatus.OK)
  async connexion(
    @Body() dto: ConnexionDto,
    @Ip() adresseIp: string,
  ): Promise<ResultatConnexion> {
    return this.service.connecter(dto.telephone, dto.mot_de_passe, adresseIp);
  }

  /**
   * Renvoie la session courante. Utile à l'interface au rechargement d'une page :
   * elle connaît le jeton mais pas ce qu'il porte.
   */
  @Get('session')
  session(@SessionCourante() session: Session): Session {
    return session;
  }
}

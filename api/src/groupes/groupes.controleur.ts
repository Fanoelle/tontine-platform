import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../authentification/roles.decorator';
import { SessionCourante, type Session } from '../authentification/session';
import { GroupesService } from './groupes.service';

@Controller()
export class GroupesControleur {
  constructor(private readonly service: GroupesService) {}

  /** F-TDB-01, F-TDB-05 — accueil. Accessible à tout membre authentifié. */
  @Get('tableau-de-bord')
  tableauDeBord(@SessionCourante() session: Session) {
    return this.service.tableauDeBord(session);
  }

  /** F-MBR-03 */
  @Get('membres')
  membres(@SessionCourante() session: Session) {
    return this.service.membres(session);
  }

  /** F-TOU-02 */
  @Get('tours')
  tours(@SessionCourante() session: Session) {
    return this.service.tours(session);
  }

  /** F-TOU-03 — remise de la cagnotte. Trésorier uniquement. */
  @Post('tours/:id/remise')
  @Roles('TRESORIER')
  @HttpCode(HttpStatus.OK)
  remettre(
    @SessionCourante() session: Session,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.remettre(session, id);
  }

  /** F-RAP-02, F-TRX-04 — `?date=AAAA-MM-JJ` pour une situation passée. */
  @Get('situation-caisse')
  @Roles('TRESORIER', 'PRESIDENT', 'COMMISSAIRE')
  situationCaisse(
    @SessionCourante() session: Session,
    @Query('date') date?: string,
  ) {
    return this.service.situationCaisse(session, date);
  }

  /** F-RAP-03 */
  @Get('recouvrement')
  @Roles('TRESORIER', 'PRESIDENT', 'COMMISSAIRE')
  recouvrement(@SessionCourante() session: Session) {
    return this.service.recouvrement(session);
  }

  /**
   * F-TRX-03 — journal des opérations.
   *
   * Réservé au commissaire aux comptes et au bureau : c'est la vue la plus
   * proche du mécanisme comptable, et elle n'est pas destinée aux membres
   * (N-USG-05). Un membre lit son relevé, pas le journal.
   */
  @Get('journal')
  @Roles('COMMISSAIRE', 'TRESORIER', 'PRESIDENT')
  journal(
    @SessionCourante() session: Session,
    @Query('limite', new ParseIntPipe({ optional: true })) limite?: number,
  ) {
    return this.service.journal(session, limite ?? 50);
  }
}

/**
 * Vérifie les habilitations, côté serveur, à chaque appel (N-SEC-05).
 *
 * S'exécute après JetonGarde, qui a déjà reconstitué la session depuis la base —
 * les rôles contrôlés ici sont donc les rôles ACTIFS du moment, pas ceux gelés
 * dans le jeton à la connexion.
 *
 * LE CUMUL DES RÔLES EST AUTORISÉ. Dans les petits groupes, une même personne
 * préside et tient la caisse : le modèle le permet (F-MBR-02). Un seul des rôles
 * exigés suffit donc à passer. C'est l'interface, non cette garde, qui signale
 * le cumul trésorier/commissaire (F-MBR-06) : le refuser ici empêcherait des
 * groupes réels de fonctionner.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BaseService } from '../base/base.service';
import { CLE_ROLES } from './roles.decorator';
import type { RequeteAuthentifiee, RoleMembre } from './session';

@Injectable()
export class RolesGarde implements CanActivate {
  private readonly journal = new Logger(RolesGarde.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly base: BaseService,
  ) {}

  async canActivate(contexte: ExecutionContext): Promise<boolean> {
    const requis = this.reflector.getAllAndOverride<RoleMembre[]>(CLE_ROLES, [
      contexte.getHandler(),
      contexte.getClass(),
    ]);

    // Aucun rôle exigé : être authentifié suffit. JetonGarde s'en est chargé.
    if (!requis || requis.length === 0) {
      return true;
    }

    const requete = contexte.switchToHttp().getRequest<RequeteAuthentifiee>();
    const session = requete.session;

    if (!session) {
      throw new ForbiddenException('Session absente');
    }

    const autorise = requis.some((role) => session.roles.includes(role));

    if (!autorise) {
      // La tentative est consignée (N-SEC-06) : un refus d'habilitation est une
      // information d'audit, pas un simple code 403.
      this.journal.warn(
        `Habilitation refusée : ${session.membre_id} (${session.roles.join(', ') || 'aucun rôle'}) ` +
          `a tenté ${requete.method} ${requete.path}, qui exige ${requis.join(' ou ')}`,
      );

      try {
        await this.base.requete(
          `INSERT INTO journal_acces (utilisateur_id, action, ressource, autorise, adresse_ip)
           VALUES ($1, $2, $3, false, $4)`,
          [
            session.utilisateur_id,
            requete.method,
            requete.path,
            requete.ip ?? null,
          ],
        );
      } catch (erreur) {
        this.journal.warn(
          `Journal d'accès indisponible : ${(erreur as Error).message}`,
        );
      }

      throw new ForbiddenException(
        `Cette action requiert le rôle : ${requis.join(' ou ')}`,
      );
    }

    return true;
  }
}

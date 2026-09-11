/**
 * Garde GLOBALE : toute route est protégée, sauf marquée @Public() (N-SEC-04).
 *
 * Elle vérifie le jeton, reconstitue la session et l'attache à la requête. Le
 * groupe est lu dans le jeton (N-SEC-03) : c'est ici que naît le cloisonnement
 * dont dépend tout le reste.
 *
 * POURQUOI RELIRE LA BASE À CHAQUE APPEL. Le jeton porte les rôles, mais il est
 * signé une fois pour plusieurs heures. Un membre suspendu, radié, ou dont on a
 * retiré le rôle de trésorier conserverait ses droits jusqu'à expiration. Le
 * coût est une requête indexée par appel ; le bénéfice est qu'une révocation
 * prend effet immédiatement. Pour une plateforme qui manipule l'argent de tiers,
 * l'arbitrage n'est pas discutable.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { BaseService } from '../base/base.service';
import { CLE_PUBLIQUE } from './public.decorator';
import type {
  ChargeJeton,
  RequeteAuthentifiee,
  RoleMembre,
} from './session';

interface LigneSession {
  utilisateur_id: string;
  membre_id: string;
  groupe_id: string;
  actif: boolean;
  statut_membre: 'ACTIF' | 'SUSPENDU' | 'RADIE';
  supprime: boolean;
  roles: string[];
}

@Injectable()
export class JetonGarde implements CanActivate {
  private readonly journal = new Logger(JetonGarde.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly base: BaseService,
  ) {}

  async canActivate(contexte: ExecutionContext): Promise<boolean> {
    const estPublique = this.reflector.getAllAndOverride<boolean>(
      CLE_PUBLIQUE,
      [contexte.getHandler(), contexte.getClass()],
    );
    if (estPublique) {
      return true;
    }

    const requete = contexte.switchToHttp().getRequest<RequeteAuthentifiee>();
    const jeton = this.extraireJeton(requete);

    if (!jeton) {
      throw new UnauthorizedException('Jeton absent');
    }

    let charge: ChargeJeton;
    try {
      charge = await this.jwt.verifyAsync<ChargeJeton>(jeton);
    } catch {
      // Le détail (expiré, signature invalide, malformé) n'est pas renvoyé :
      // il renseignerait un attaquant sans aider un utilisateur légitime.
      throw new UnauthorizedException('Jeton invalide ou expiré');
    }

    const session = await this.base.requeteUne<LigneSession>(
      `SELECT utilisateur_id, membre_id, groupe_id, actif,
              statut_membre, supprime, roles
         FROM v_authentification
        WHERE utilisateur_id = $1`,
      [charge.sub],
    );

    if (!session) {
      throw new UnauthorizedException('Compte introuvable');
    }

    // Un compte désactivé, un membre radié ou supprimé n'ouvre plus de session —
    // même avec un jeton encore valide. R-08 conserve son historique comptable,
    // pas son accès.
    if (!session.actif || session.supprime || session.statut_membre === 'RADIE') {
      await this.consigner(session.utilisateur_id, requete, false);
      throw new UnauthorizedException('Compte désactivé');
    }

    // Le groupe du jeton doit correspondre à celui du membre en base. Une
    // divergence signale un jeton forgé ou un membre déplacé : dans les deux
    // cas, la session est refusée (N-SEC-02).
    if (session.groupe_id !== charge.groupe_id) {
      this.journal.error(
        `Cloisonnement : jeton du groupe ${charge.groupe_id} pour un membre du ` +
          `groupe ${session.groupe_id} (utilisateur ${session.utilisateur_id})`,
      );
      await this.consigner(session.utilisateur_id, requete, false);
      throw new UnauthorizedException('Jeton incohérent');
    }

    requete.session = {
      utilisateur_id: session.utilisateur_id,
      membre_id: session.membre_id,
      groupe_id: session.groupe_id,
      roles: session.roles as RoleMembre[],
    };

    return true;
  }

  private extraireJeton(requete: RequeteAuthentifiee): string | null {
    const entete = requete.headers.authorization;
    if (!entete) {
      return null;
    }
    const [schema, valeur] = entete.split(' ');
    return schema === 'Bearer' && valeur ? valeur : null;
  }

  private async consigner(
    utilisateurId: string,
    requete: RequeteAuthentifiee,
    autorise: boolean,
  ): Promise<void> {
    // L'audit ne doit jamais faire échouer la requête qu'il observe : une panne
    // d'écriture du journal d'accès n'est pas une raison de refuser un service.
    try {
      await this.base.requete(
        `INSERT INTO journal_acces (utilisateur_id, action, ressource, autorise, adresse_ip)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          utilisateurId,
          requete.method,
          requete.path,
          autorise,
          requete.ip ?? null,
        ],
      );
    } catch (erreur) {
      this.journal.warn(
        `Journal d'accès indisponible : ${(erreur as Error).message}`,
      );
    }
  }
}

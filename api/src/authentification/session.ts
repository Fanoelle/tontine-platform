/**
 * Ce que porte une session authentifiée.
 *
 * LE GROUPE EST DANS LE JETON (N-SEC-03). C'est la garantie structurante du
 * cloisonnement : puisqu'aucun identifiant de groupe ne transite par l'URL, une
 * fuite transversale devient impossible par construction — et non « évitée si
 * l'on pense à filtrer ». Tout service métier reçoit le groupe depuis la
 * session, jamais depuis un paramètre de requête.
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Rôles du modèle — miroir exact de l'ENUM `role_membre` (migration 001). */
export type RoleMembre = 'MEMBRE' | 'TRESORIER' | 'PRESIDENT' | 'COMMISSAIRE';

/** Contenu du jeton JWT, tel que signé à la connexion. */
export interface ChargeJeton {
  /** Sujet : l'utilisateur. */
  sub: string;
  membre_id: string;
  /** N-SEC-03 — le groupe vient d'ici, jamais de l'URL. */
  groupe_id: string;
  roles: RoleMembre[];
}

/** Session reconstituée à partir du jeton, attachée à la requête. */
export interface Session {
  utilisateur_id: string;
  membre_id: string;
  groupe_id: string;
  roles: RoleMembre[];
}

/** Requête Express portant une session authentifiée. */
export interface RequeteAuthentifiee extends Request {
  session?: Session;
}

/**
 * Injecte la session dans un contrôleur : `methode(@SessionCourante() s: Session)`.
 *
 * Lire `request.session` à la main dans chaque contrôleur fonctionnerait, mais
 * le décorateur rend la dépendance visible dans la signature — et donc
 * impossible à oublier silencieusement.
 */
export const SessionCourante = createParamDecorator(
  (_donnees: unknown, contexte: ExecutionContext): Session => {
    const requete = contexte.switchToHttp().getRequest<RequeteAuthentifiee>();
    if (!requete.session) {
      // Ne peut survenir que si une route est ouverte par @Public() tout en
      // réclamant la session : c'est une erreur de programmation, pas une
      // erreur d'utilisateur.
      throw new Error(
        'Aucune session sur cette requête : route ouverte par @Public() mais ' +
          'utilisant @SessionCourante().',
      );
    }
    return requete.session;
  },
);

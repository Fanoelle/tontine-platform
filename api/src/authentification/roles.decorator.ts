/**
 * Exige un ou plusieurs rôles sur une route (N-SEC-05).
 *
 * Les rôles sont vérifiés CÔTÉ SERVEUR À CHAQUE APPEL, depuis le jeton, et
 * jamais depuis une information fournie par le client. Un rôle affiché par
 * l'interface est un confort d'ergonomie ; il n'a aucune valeur d'habilitation.
 */
import { SetMetadata } from '@nestjs/common';
import type { RoleMembre } from './session';

export const CLE_ROLES = 'roles_requis';

/** Un seul des rôles listés suffit (disjonction). */
export const Roles = (...roles: RoleMembre[]) => SetMetadata(CLE_ROLES, roles);

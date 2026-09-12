/**
 * Ouverture de session (N-SEC-01).
 *
 * L'identifiant de connexion est le TÉLÉPHONE, pas l'e-mail : beaucoup de
 * membres n'ont pas d'adresse électronique (F-MBR-01).
 */
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { BaseService } from '../base/base.service';
import type { ChargeJeton, RoleMembre } from './session';

/** Coût bcrypt. 12 ≈ 250 ms : assez lent pour décourager l'attaque hors ligne,
 *  assez rapide pour une connexion. La lenteur est la fonction, pas le défaut. */
const COUT_BCRYPT = 12;

/** Hachage d'un mot de passe fictif, utilisé pour égaliser les temps de réponse. */
const LEURRE = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.9pTNXhTDPfKPT2qDoTZoJpYmQ0rCjJq';

interface LigneAuthentification {
  utilisateur_id: string;
  telephone: string;
  mot_de_passe_hash: string;
  actif: boolean;
  membre_id: string;
  groupe_id: string;
  nom_complet: string;
  statut_membre: 'ACTIF' | 'SUSPENDU' | 'RADIE';
  supprime: boolean;
  groupe_nom: string;
  groupe_type: 'ROSCA' | 'ASCA' | 'MUTUELLE';
  cycle_en_cours: boolean;
  roles: string[];
}

export interface ResultatConnexion {
  jeton: string;
  membre: {
    id: string;
    nom_complet: string;
    roles: RoleMembre[];
  };
  groupe: {
    id: string;
    nom: string;
    type: 'ROSCA' | 'ASCA' | 'MUTUELLE';
    /** Vrai dès qu'un cycle existe — l'import de cahier est alors fermé. */
    cycle_en_cours: boolean;
  };
}

@Injectable()
export class AuthentificationService {
  private readonly journal = new Logger(AuthentificationService.name);

  constructor(
    private readonly base: BaseService,
    private readonly jwt: JwtService,
  ) {}

  async connecter(
    telephone: string,
    motDePasse: string,
    adresseIp?: string,
  ): Promise<ResultatConnexion> {
    const compte = await this.base.requeteUne<LigneAuthentification>(
      // `cycle_en_cours` est calculé ici plutôt qu'ajouté à la vue : il ne sert
      // qu'à l'interface, qui masque l'onglet « Reprendre un cahier » pour un
      // groupe déjà en activité. L'ajouter à `v_authentification` ferait payer
      // ce calcul à tout ce qui lit la vue, pour un besoin d'affichage.
      `SELECT v.utilisateur_id, v.telephone, v.mot_de_passe_hash, v.actif,
              v.membre_id, v.groupe_id, v.nom_complet, v.statut_membre,
              v.supprime, v.groupe_nom, v.groupe_type, v.roles,
              EXISTS (SELECT 1 FROM cycle c WHERE c.groupe_id = v.groupe_id)
                AS cycle_en_cours
         FROM v_authentification v
        WHERE v.telephone = $1`,
      [telephone],
    );

    // POURQUOI COMPARER MALGRÉ UN COMPTE INTROUVABLE. Sans ce leurre, une
    // réponse immédiate trahirait qu'aucun compte ne porte ce numéro, là qu'un
    // compte existant coûterait 250 ms de bcrypt. L'écart de temps suffit à
    // énumérer les membres d'un groupe.
    const hachage = compte?.mot_de_passe_hash ?? LEURRE;
    const correspond = await bcrypt.compare(motDePasse, hachage);

    if (!compte || !correspond) {
      await this.consignerEchec(compte?.utilisateur_id ?? null, adresseIp);
      // Message volontairement indistinct : ne pas révéler lequel des deux
      // éléments est erroné.
      throw new UnauthorizedException('Téléphone ou mot de passe incorrect');
    }

    if (!compte.actif || compte.supprime || compte.statut_membre === 'RADIE') {
      await this.consignerEchec(compte.utilisateur_id, adresseIp);
      throw new UnauthorizedException('Compte désactivé');
    }

    const roles = compte.roles as RoleMembre[];

    // N-SEC-03 — le groupe est scellé dans le jeton. Aucune route ne le lira
    // jamais depuis une URL.
    const charge: ChargeJeton = {
      sub: compte.utilisateur_id,
      membre_id: compte.membre_id,
      groupe_id: compte.groupe_id,
      roles,
    };

    const jeton = await this.jwt.signAsync(charge);

    await this.base.requete(
      `UPDATE utilisateur SET dernier_acces_le = now() WHERE id = $1`,
      [compte.utilisateur_id],
    );

    await this.base.requete(
      `INSERT INTO journal_acces (utilisateur_id, action, ressource, autorise, adresse_ip)
       VALUES ($1, 'CONNEXION', 'session', true, $2)`,
      [compte.utilisateur_id, adresseIp ?? null],
    );

    this.journal.log(
      `Session ouverte : ${compte.nom_complet} (${roles.join(', ') || 'aucun rôle'}) ` +
        `— groupe ${compte.groupe_nom}`,
    );

    return {
      jeton,
      membre: {
        id: compte.membre_id,
        nom_complet: compte.nom_complet,
        roles,
      },
      groupe: {
        id: compte.groupe_id,
        nom: compte.groupe_nom,
        type: compte.groupe_type,
        cycle_en_cours: compte.cycle_en_cours,
      },
    };
  }

  /** Hache un mot de passe pour création ou réinitialisation de compte. */
  async hacher(motDePasse: string): Promise<string> {
    return bcrypt.hash(motDePasse, COUT_BCRYPT);
  }

  private async consignerEchec(
    utilisateurId: string | null,
    adresseIp?: string,
  ): Promise<void> {
    try {
      await this.base.requete(
        `INSERT INTO journal_acces (utilisateur_id, action, ressource, autorise, adresse_ip)
         VALUES ($1, 'CONNEXION', 'session', false, $2)`,
        [utilisateurId, adresseIp ?? null],
      );
    } catch (erreur) {
      this.journal.warn(
        `Journal d'accès indisponible : ${(erreur as Error).message}`,
      );
    }
  }
}

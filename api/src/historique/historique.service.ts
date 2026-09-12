/**
 * Historique des opérations — N-TRC-01, N-SEC-06.
 *
 * CE QUE CE SERVICE APPORTE, QUE LE JOURNAL COMPTABLE N'APPORTAIT PAS.
 *
 * Le journal prouve les MOUVEMENTS D'ARGENT : un versement, une remise, un
 * remboursement. Mais beaucoup de décisions ne produisent aucune écriture —
 * une dispense accordée, un prêt refusé, une anomalie levée, un relevé importé.
 * Ce sont précisément les plus contestables en assemblée, et rien ne permettait
 * de dire qui les avait prises.
 *
 * L'HISTORIQUE EST IMMUABLE, comme le journal. Une piste d'audit modifiable ne
 * prouve rien : c'est le raisonnement de R-02, appliqué aux décisions.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { BaseService } from '../base/base.service';
import type { Session } from '../authentification/session';

export interface LigneHistorique {
  id: string;
  type: string;
  categorie: string;
  horodatage: string;
  libelle: string;
  motif: string | null;
  montant: string | null;
  auteur: string;
  membre_vise: string | null;
  ecriture_id: string | null;
  pret_id: string | null;
  aide_id: string | null;
  anomalie_id: string | null;
}

@Injectable()
export class HistoriqueService {
  constructor(private readonly base: BaseService) {}

  /**
   * Historique du groupe, le plus récent d'abord.
   *
   * `categorie` permet de filtrer sans connaître les dix-sept types : un
   * commissaire cherche « Contrôle », un trésorier « Argent ».
   */
  async lister(
    session: Session,
    categorie?: string,
    limite = 100,
  ): Promise<LigneHistorique[]> {
    return this.base.requete<LigneHistorique & Record<string, unknown>>(
      `SELECT id, type::TEXT, categorie, horodatage, libelle, motif,
              montant, auteur, membre_vise,
              ecriture_id, pret_id, aide_id, anomalie_id
         FROM v_historique
        WHERE groupe_id = $1
          AND ($2::TEXT IS NULL OR categorie = $2)
        ORDER BY horodatage DESC
        LIMIT $3`,
      [session.groupe_id, categorie ?? null, Math.min(limite, 500)],
    );
  }

  /**
   * Ce qu'un membre donné a fait.
   *
   * Réservé au bureau côté contrôleur : donner à chacun l'historique de ses
   * pairs transformerait un outil de contrôle mutuel en instrument de
   * surveillance réciproque.
   */
  async parAuteur(
    session: Session,
    membreId: string,
    limite = 100,
  ): Promise<LigneHistorique[]> {
    const trouve = await this.base.requeteUne<{ existe: boolean }>(
      `SELECT true AS existe FROM membre
        WHERE id = $1 AND groupe_id = $2`,
      [membreId, session.groupe_id],
    );

    if (!trouve) {
      throw new NotFoundException('Membre introuvable');
    }

    return this.base.requete<LigneHistorique & Record<string, unknown>>(
      `SELECT h.id, h.type::TEXT, h.categorie, h.horodatage, h.libelle,
              h.motif, h.montant, h.auteur, h.membre_vise,
              h.ecriture_id, h.pret_id, h.aide_id, h.anomalie_id
         FROM v_historique h
         JOIN historique b ON b.id = h.id
        WHERE h.groupe_id = $1 AND b.auteur_id = $2
        ORDER BY h.horodatage DESC
        LIMIT $3`,
      [session.groupe_id, membreId, Math.min(limite, 500)],
    );
  }

  /** Synthèse par catégorie, pour le rapport d'assemblée. */
  async synthese(session: Session): Promise<Record<string, unknown>[]> {
    return this.base.requete(
      `SELECT categorie,
              count(*)                     AS operations,
              count(DISTINCT auteur)       AS intervenants,
              min(horodatage)              AS premiere,
              max(horodatage)              AS derniere
         FROM v_historique
        WHERE groupe_id = $1
        GROUP BY categorie
        ORDER BY count(*) DESC`,
      [session.groupe_id],
    );
  }

  /**
   * Journal d'accès — la trace TECHNIQUE, distincte de l'historique métier.
   *
   * Réservé au commissaire aux comptes : il contient les tentatives refusées,
   * qui relèvent du contrôle et non de la gestion courante.
   */
  async acces(session: Session, limite = 100): Promise<Record<string, unknown>[]> {
    return this.base.requete(
      `SELECT j.action, j.ressource, j.autorise, j.horodatage,
              j.adresse_ip::TEXT AS adresse,
              m.nom_complet AS membre
         FROM journal_acces j
         LEFT JOIN utilisateur u ON u.id = j.utilisateur_id
         LEFT JOIN membre m ON m.id = u.membre_id
        WHERE m.groupe_id = $1
        ORDER BY j.horodatage DESC
        LIMIT $2`,
      [session.groupe_id, Math.min(limite, 500)],
    );
  }
}

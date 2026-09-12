/**
 * Groupes, membres, tours et tableau de bord — lecture principalement.
 *
 * Toutes les requêtes filtrent sur le groupe de la session (N-SEC-02). Aucune
 * n'accepte un identifiant de groupe en paramètre.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseError } from 'pg';
import { BadRequestException } from '@nestjs/common';
import { BaseService } from '../base/base.service';
import type { Session } from '../authentification/session';

@Injectable()
export class GroupesService {
  constructor(private readonly base: BaseService) {}

  /** F-TDB-01, F-TDB-05 — écran d'accueil du trésorier, en une requête. */
  async tableauDeBord(session: Session): Promise<Record<string, unknown>> {
    const ligne = await this.base.requeteUne(
      `SELECT groupe, mecanisme, devise, tresorerie,
              cycle_id, cycle_numero, cycle_statut,
              taux_recouvrement, echeances_en_attente,
              tour_rang, prochain_beneficiaire, date_remise_prevue,
              cagnotte_encaissee, cagnotte_attendue, manque_pour_remise,
              membres_actifs
         FROM v_tableau_de_bord
        WHERE groupe_id = $1`,
      [session.groupe_id],
    );

    if (!ligne) {
      throw new NotFoundException('Groupe introuvable');
    }
    return ligne;
  }

  /** F-MBR-03 — liste des membres et de leur situation. */
  async membres(session: Session): Promise<Record<string, unknown>[]> {
    // Le filtre `NOT supprime` vaut pour un listing, jamais pour une requête
    // comptable : le journal ignore le statut courant d'un membre, sans quoi
    // les soldes historiques changeraient rétroactivement (R-08).
    return this.base.requete(
      `SELECT m.id, m.nom_complet, m.telephone, m.date_adhesion, m.statut,
              COALESCE(ARRAY(SELECT mr.role::TEXT FROM membre_role mr
                              WHERE mr.membre_id = m.id AND mr.retire_le IS NULL
                              ORDER BY mr.role::TEXT), ARRAY[]::TEXT[]) AS roles,
              COALESCE((SELECT SUM(e.montant_regle) FROM echeance e
                         WHERE e.membre_id = m.id), 0)                  AS total_verse,
              COALESCE((SELECT SUM(e.montant_attendu - e.montant_regle)
                          FROM echeance e
                         WHERE e.membre_id = m.id
                           AND e.statut NOT IN ('REGLEE', 'DISPENSEE')), 0)
                                                                        AS reste_du
         FROM membre m
        WHERE m.groupe_id = $1 AND NOT m.supprime
        ORDER BY m.nom_complet`,
      [session.groupe_id],
    );
  }

  /** F-TOU-02 — tours du cycle courant, avec l'écart qui bloque la remise. */
  async tours(session: Session): Promise<Record<string, unknown>[]> {
    return this.base.requete(
      `SELECT tour_id, rang, beneficiaire, date_remise_prevue,
              date_remise_reelle, montant_cagnotte,
              cagnotte_attendue, cagnotte_encaissee, manque, remis
         FROM v_tour_courant
        WHERE groupe_id = $1
        ORDER BY rang`,
      [session.groupe_id],
    );
  }

  /**
   * F-TOU-03 — remise de la cagnotte.
   *
   * La fonction SQL refuse si une échéance reste non réglée : distribuer de
   * l'argent absent de la caisse est le mode de défaillance classique des
   * tontines rotatives. Le refus remonte en 400 avec son message d'origine,
   * qui dit combien il manque et sur combien.
   */
  async remettre(
    session: Session,
    tourId: string,
  ): Promise<Record<string, unknown>> {
    const appartient = await this.base.requeteUne<{ existe: boolean }>(
      `SELECT true AS existe
         FROM tour t JOIN cycle c ON c.id = t.cycle_id
        WHERE t.id = $1 AND c.groupe_id = $2`,
      [tourId, session.groupe_id],
    );

    if (!appartient) {
      throw new NotFoundException('Tour introuvable');
    }

    try {
      const lignes = await this.base.requete(
        `SELECT * FROM remettre_cagnotte($1, $2)`,
        [tourId, session.membre_id],
      );
      return lignes[0];
    } catch (erreur) {
      if (erreur instanceof DatabaseError && erreur.code === '23514') {
        throw new BadRequestException(erreur.message);
      }
      throw erreur;
    }
  }

  /** F-RAP-02, F-TRX-04 — situation de caisse, éventuellement à une date passée. */
  async situationCaisse(
    session: Session,
    date?: string,
  ): Promise<Record<string, unknown>> {
    if (date) {
      const ligne = await this.base.requeteUne(
        `SELECT situation_caisse_a_date($1, $2::DATE) AS tresorerie, $2::DATE AS a_la_date`,
        [session.groupe_id, date],
      );
      return ligne!;
    }

    const ligne = await this.base.requeteUne(
      `SELECT groupe, devise, tresorerie, especes, banque,
              nombre_operations, derniere_operation
         FROM v_situation_caisse
        WHERE groupe_id = $1`,
      [session.groupe_id],
    );

    if (!ligne) {
      throw new NotFoundException('Groupe introuvable');
    }
    return ligne;
  }

  /** F-RAP-03 — état du recouvrement par cycle. */
  async recouvrement(session: Session): Promise<Record<string, unknown>[]> {
    return this.base.requete(
      `SELECT cycle_id, cycle_numero, cycle_statut, echeances,
              reglees, partielles, impayees, attendues, dispensees,
              total_appele, total_encaisse, taux_recouvrement
         FROM v_recouvrement
        WHERE groupe_id = $1
        ORDER BY cycle_numero DESC`,
      [session.groupe_id],
    );
  }

  /** F-TRX-03 — journal des opérations, filtré et daté. */
  async journal(
    session: Session,
    limite = 50,
  ): Promise<Record<string, unknown>[]> {
    return this.base.requete(
      `SELECT e.numero, e.date_operation, e.libelle, e.nature,
              e.cree_le, m.nom_complet AS saisi_par,
              e.ecriture_corrigee_id IS NOT NULL AS est_correction,
              e.motif_correction,
              (SELECT SUM(l.montant) FROM ligne_ecriture l
                WHERE l.ecriture_id = e.id AND l.sens = 'DEBIT') AS montant
         FROM ecriture e
         JOIN membre m ON m.id = e.saisi_par
        WHERE e.groupe_id = $1
        ORDER BY e.numero DESC
        LIMIT $2`,
      [session.groupe_id, Math.min(limite, 200)],
    );
  }
}

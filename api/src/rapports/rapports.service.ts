/**
 * Rapports, exports et rapprochement Mobile Money — jalon 3.
 *
 * F-RAP-05, F-RAP-06, F-TRX-06, F-PRE-07, F-EPA-03/04, F-GRP-06.
 *
 * LE RAPPROCHEMENT N'ÉCRIT RIEN DANS LE JOURNAL. Un relevé d'opérateur est une
 * source externe dont la plateforme ne maîtrise ni le format ni la fiabilité.
 * En importer automatiquement les lignes comme des versements reviendrait à
 * laisser un tiers écrire dans les comptes du groupe. Le service compare et
 * signale ; le trésorier saisit s'il y a lieu.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseError } from 'pg';
import { BaseService } from '../base/base.service';
import type { Session } from '../authentification/session';

export interface LigneRapport {
  rubrique: string;
  intitule: string;
  valeur: string;
  montant: string | null;
}

export interface LigneRapprochement {
  statut: string;
  reference: string;
  montant_releve: string | null;
  montant_registre: string | null;
  date_operation: string;
  membre: string | null;
  commentaire: string | null;
}

export interface SyntheseRapprochement {
  rapproches: number;
  absents_du_registre: number;
  absents_du_releve: number;
  montant_rapproche: string;
  montant_en_ecart: string;
}

export interface LigneRedistribution {
  membre_id: string;
  nom_complet: string;
  parts: number;
  epargne: string;
  quote_part: string;
  total_a_restituer: string;
}

@Injectable()
export class RapportsService {
  constructor(private readonly base: BaseService) {}

  private traduire(erreur: unknown): never {
    if (erreur instanceof DatabaseError) {
      switch (erreur.code) {
        case 'P0002':
          throw new NotFoundException(erreur.message);
        case '42501':
          throw new ForbiddenException(erreur.message);
        case '23514':
        case '23505':
        case '23503':
          throw new BadRequestException(erreur.message);
        default:
          break;
      }
    }
    throw erreur;
  }

  /** F-RAP-05 — rapport d'assemblée, toutes valeurs recalculées. */
  async rapportAssemblee(
    session: Session,
    date?: string,
  ): Promise<LigneRapport[]> {
    return this.base.requete<LigneRapport & Record<string, unknown>>(
      `SELECT rubrique, intitule, valeur, montant
         FROM rapport_assemblee($1, COALESCE($2::DATE, CURRENT_DATE))`,
      [session.groupe_id, date ?? null],
    );
  }

  /**
   * F-RAP-06 — exports CSV.
   *
   * Le contenu est produit par la base, qui échappe déjà les séparateurs et
   * les guillemets. Le service se contente de joindre les lignes : reformater
   * ici risquerait de défaire cet échappement.
   */
  async exporter(
    session: Session,
    quoi: 'journal' | 'membres' | 'rapport',
    debut?: string,
    fin?: string,
  ): Promise<string> {
    const requetes = {
      journal: [
        `SELECT exporter_journal_csv($1, $2::DATE, $3::DATE) AS ligne`,
        [session.groupe_id, debut ?? null, fin ?? null],
      ],
      membres: [
        `SELECT exporter_membres_csv($1) AS ligne`,
        [session.groupe_id],
      ],
      rapport: [
        `SELECT exporter_rapport_csv($1, COALESCE($2::DATE, CURRENT_DATE)) AS ligne`,
        [session.groupe_id, debut ?? null],
      ],
    } as const;

    const [sql, params] = requetes[quoi];
    const lignes = await this.base.requete<{ ligne: string }>(
      sql as string,
      params as readonly unknown[],
    );

    // BOM UTF-8 en tête : sans lui, Excel en locale française lit un fichier
    // CSV comme du Latin-1 et affiche « Ã© » à la place de « é ». Un export
    // illisible n'est pas un export.
    return '﻿' + lignes.map((l) => l.ligne).join('\r\n');
  }

  /** F-TRX-06 — liste des relevés importés. */
  async releves(session: Session): Promise<Record<string, unknown>[]> {
    return this.base.requete(
      `SELECT r.id, r.operateur, r.periode_debut, r.periode_fin,
              r.importe_le, m.nom_complet AS importe_par,
              (SELECT count(*) FROM ligne_releve l WHERE l.releve_id = r.id)
                  AS lignes
         FROM releve_mobile_money r
         JOIN membre m ON m.id = r.importe_par
        WHERE r.groupe_id = $1
        ORDER BY r.importe_le DESC`,
      [session.groupe_id],
    );
  }

  /**
   * F-TRX-06 — importe un relevé.
   *
   * L'import et ses lignes vivent dans UNE transaction : un relevé à moitié
   * importé produirait un rapprochement faux, signalant comme manquantes des
   * opérations simplement absentes de l'import.
   */
  async importerReleve(
    session: Session,
    operateur: string,
    periodeDebut: string,
    periodeFin: string,
    lignes: Array<{
      reference: string;
      montant: number;
      date_operation: string;
      telephone?: string;
      libelle?: string;
    }>,
  ): Promise<{ id: string; lignes: number }> {
    try {
      return await this.base.transaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO releve_mobile_money
               (groupe_id, operateur, periode_debut, periode_fin, importe_par)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [session.groupe_id, operateur, periodeDebut, periodeFin,
           session.membre_id],
        );
        const releveId = rows[0].id;

        for (const l of lignes) {
          await client.query(
            `INSERT INTO ligne_releve
                 (releve_id, reference, montant, date_operation, telephone, libelle)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [releveId, l.reference, l.montant, l.date_operation,
             l.telephone ?? null, l.libelle ?? null],
          );
        }

        return { id: releveId, lignes: lignes.length };
      });
    } catch (erreur) {
      this.traduire(erreur);
    }
  }

  async rapprocher(
    session: Session,
    releveId: string,
  ): Promise<{
    synthese: SyntheseRapprochement;
    lignes: LigneRapprochement[];
  }> {
    await this.exigerReleveDuGroupe(session, releveId);

    const synthese = await this.base.requeteUne<
      SyntheseRapprochement & Record<string, unknown>
    >(`SELECT * FROM synthese_rapprochement($1)`, [releveId]);

    const lignes = await this.base.requete<
      LigneRapprochement & Record<string, unknown>
    >(`SELECT statut::TEXT, reference, montant_releve, montant_registre,
              date_operation, membre, commentaire
         FROM rapprocher_releve($1)`, [releveId]);

    return { synthese: synthese!, lignes };
  }

  /** F-EPA-03, F-EPA-04 — décompte de redistribution ASCA. */
  async decompteRedistribution(
    session: Session,
  ): Promise<LigneRedistribution[]> {
    const cycle = await this.base.requeteUne<{ id: string }>(
      `SELECT id FROM cycle WHERE groupe_id = $1 AND statut = 'EN_COURS'`,
      [session.groupe_id],
    );

    if (!cycle) {
      throw new BadRequestException('Aucun cycle ouvert');
    }

    try {
      return await this.base.requete<
        LigneRedistribution & Record<string, unknown>
      >(`SELECT * FROM decompte_redistribution($1)`, [cycle.id]);
    } catch (erreur) {
      this.traduire(erreur);
    }
  }

  /** F-PRE-07 — rééchelonnement. Le capital restant dû est inchangé. */
  async reechelonner(
    session: Session,
    pretId: string,
    echeances: number,
    motif: string,
  ): Promise<Record<string, unknown>> {
    const trouve = await this.base.requeteUne<{ existe: boolean }>(
      `SELECT true AS existe
         FROM pret p JOIN cycle c ON c.id = p.cycle_id
        WHERE p.id = $1 AND c.groupe_id = $2`,
      [pretId, session.groupe_id],
    );

    if (!trouve) {
      throw new NotFoundException('Prêt introuvable');
    }

    try {
      const lignes = await this.base.requete(
        `SELECT * FROM reechelonner_pret($1, $2, $3, $4)`,
        [pretId, echeances, motif, session.membre_id],
      );
      return lignes[0];
    } catch (erreur) {
      this.traduire(erreur);
    }
  }

  /** F-GRP-06 — archivage. Refusé tant qu'une créance est vivante. */
  async archiver(session: Session): Promise<Record<string, unknown>> {
    try {
      const lignes = await this.base.requete(
        `SELECT * FROM archiver_groupe($1, $2)`,
        [session.groupe_id, session.membre_id],
      );
      return lignes[0];
    } catch (erreur) {
      this.traduire(erreur);
    }
  }

  private async exigerReleveDuGroupe(
    session: Session,
    releveId: string,
  ): Promise<void> {
    const trouve = await this.base.requeteUne<{ existe: boolean }>(
      `SELECT true AS existe FROM releve_mobile_money
        WHERE id = $1 AND groupe_id = $2`,
      [releveId, session.groupe_id],
    );

    if (!trouve) {
      throw new NotFoundException('Relevé introuvable');
    }
  }
}

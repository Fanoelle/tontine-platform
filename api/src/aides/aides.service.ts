/**
 * Aides mutualistes — F-AID.
 *
 * UNE AIDE N'EST PAS UN PRÊT. Elle n'ouvre aucune créance et n'est pas
 * remboursable : cotiser dans une mutuelle n'ouvre aucun droit, et une aide est
 * une décision du groupe. C'est pourquoi ce service est distinct de celui des
 * prêts plutôt qu'un cas particulier partageant une abstraction.
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

export interface LigneAide {
  id: string;
  beneficiaire_id: string;
  beneficiaire: string;
  motif: string;
  montant_demande: string;
  montant_accorde: string | null;
  statut: string;
  date_demande: string;
  date_decision: string | null;
  date_versement: string | null;
  motif_decision: string | null;
}

export interface Eligibilite {
  eligible: boolean;
  anciennete_mois: number;
  cotisations_dues: string;
  reserve: string | null;
}

@Injectable()
export class AidesService {
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

  async lister(session: Session): Promise<LigneAide[]> {
    return this.base.requete<LigneAide & Record<string, unknown>>(
      `SELECT a.id, a.beneficiaire_id, m.nom_complet AS beneficiaire,
              a.motif, a.montant_demande, a.montant_accorde, a.statut,
              a.date_demande, a.date_decision, a.date_versement,
              a.motif_decision
         FROM aide a
         JOIN cycle  c ON c.id = a.cycle_id
         JOIN membre m ON m.id = a.beneficiaire_id
        WHERE c.groupe_id = $1
        ORDER BY a.date_demande DESC`,
      [session.groupe_id],
    );
  }

  /**
   * F-AID-03 — éligibilité CONSULTATIVE.
   *
   * Elle ne bloque jamais : le groupe reste souverain pour secourir un membre
   * en retard de cotisation, ce qui est précisément le cas où l'aide a le plus
   * de sens. La réserve est affichée au décideur, elle ne lui lie pas les mains.
   */
  async eligibilite(session: Session, aideId: string): Promise<Eligibilite> {
    await this.exigerAideDuGroupe(session, aideId);

    const ligne = await this.base.requeteUne<Eligibilite & Record<string, unknown>>(
      `SELECT * FROM verifier_eligibilite_aide($1)`,
      [aideId],
    );
    return ligne!;
  }

  async demander(
    session: Session,
    montant: number,
    motif: string,
    beneficiaireId?: string,
  ): Promise<{ id: string }> {
    const cycle = await this.cycleOuvert(session);
    const pour = beneficiaireId ?? session.membre_id;

    if (pour !== session.membre_id) {
      if (!session.roles.includes('PRESIDENT') && !session.roles.includes('TRESORIER')) {
        throw new ForbiddenException(
          'Seul le bureau peut déposer une demande au nom d’un autre membre',
        );
      }
      await this.exigerMembreDuGroupe(session, pour);
    }

    try {
      const ligne = await this.base.requeteUne<{ id: string }>(
        `SELECT demander_aide($1, $2, $3, $4) AS id`,
        [cycle, pour, montant, motif],
      );
      return ligne!;
    } catch (erreur) {
      this.traduire(erreur);
    }
  }

  async approuver(
    session: Session,
    aideId: string,
    montant: number,
  ): Promise<{ statut: string }> {
    await this.exigerAideDuGroupe(session, aideId);

    try {
      const ligne = await this.base.requeteUne<{ statut: string }>(
        `SELECT approuver_aide($1, $2, $3) AS statut`,
        [aideId, montant, session.membre_id],
      );
      return ligne!;
    } catch (erreur) {
      this.traduire(erreur);
    }
  }

  /** F-AID-02 — verse une aide approuvée. Débite le fonds, aucune créance. */
  async verser(
    session: Session,
    aideId: string,
  ): Promise<Record<string, unknown>> {
    await this.exigerAideDuGroupe(session, aideId);

    try {
      const lignes = await this.base.requete(
        `SELECT * FROM verser_aide($1, $2)`,
        [aideId, session.membre_id],
      );
      return lignes[0];
    } catch (erreur) {
      this.traduire(erreur);
    }
  }

  private async cycleOuvert(session: Session): Promise<string> {
    const ligne = await this.base.requeteUne<{ id: string }>(
      `SELECT id FROM cycle WHERE groupe_id = $1 AND statut = 'EN_COURS'`,
      [session.groupe_id],
    );

    if (!ligne) {
      throw new BadRequestException('Aucun cycle ouvert');
    }
    return ligne.id;
  }

  private async exigerAideDuGroupe(
    session: Session,
    aideId: string,
  ): Promise<void> {
    const trouve = await this.base.requeteUne<{ existe: boolean }>(
      `SELECT true AS existe
         FROM aide a JOIN cycle c ON c.id = a.cycle_id
        WHERE a.id = $1 AND c.groupe_id = $2`,
      [aideId, session.groupe_id],
    );

    if (!trouve) {
      throw new NotFoundException('Aide introuvable');
    }
  }

  private async exigerMembreDuGroupe(
    session: Session,
    membreId: string,
  ): Promise<void> {
    const trouve = await this.base.requeteUne<{ existe: boolean }>(
      `SELECT true AS existe FROM membre
        WHERE id = $1 AND groupe_id = $2 AND NOT supprime`,
      [membreId, session.groupe_id],
    );

    if (!trouve) {
      throw new NotFoundException('Membre introuvable');
    }
  }
}

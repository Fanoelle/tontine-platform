/**
 * Prêts ASCA — F-PRE-01 à F-PRE-06.
 *
 * COMME POUR LES COTISATIONS, aucun SQL d'écriture comptable ici : les
 * fonctions de la migration 011 sont atomiques par construction. Un octroi crée
 * l'écriture, ses lignes et l'échéancier en une transaction ; reconstituer ce
 * séquencement côté TypeScript exposerait à l'interrompre à mi-chemin, et un
 * prêt sans échéancier est un état dont le journal ne se relève pas.
 *
 * LE GROUPE VIENT DE LA SESSION (N-SEC-03). Aucune méthode n'accepte de
 * `groupe_id`, et chaque ressource visée est vérifiée contre le groupe du jeton
 * avant toute opération.
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

export interface LignePret {
  id: string;
  emprunteur_id: string;
  emprunteur: string;
  montant_demande: string;
  montant_accorde: string | null;
  capital_restant_du: string;
  taux_interet: string;
  nombre_echeances: number;
  statut: string;
  motif_demande: string;
  motif_decision: string | null;
  date_demande: string;
  date_decision: string | null;
  echeances_en_retard: string;
}

export interface LigneEcheancePret {
  id: string;
  numero: number;
  date_echeance: string;
  montant_capital: string;
  montant_interet: string;
  montant_regle: string;
  statut: string;
}

@Injectable()
export class PretsService {
  constructor(private readonly base: BaseService) {}

  /**
   * Traduit une erreur PostgreSQL en réponse HTTP.
   *
   * Les messages des fonctions SQL sont déjà rédigés pour un humain — « Le prêt
   * de 99 000 000 F excède l'avoir disponible de la caisse (1 862 000 F) ». Les
   * relayer vaut mieux qu'un message générique : le président doit comprendre
   * ce qui est refusé, et de combien.
   */
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

  /** F-RAP-04 — état des prêts du groupe. */
  async lister(session: Session): Promise<LignePret[]> {
    return this.base.requete<LignePret & Record<string, unknown>>(
      `SELECT p.id, p.emprunteur_id, m.nom_complet AS emprunteur,
              p.montant_demande, p.montant_accorde, p.capital_restant_du,
              p.taux_interet, p.nombre_echeances, p.statut,
              p.motif_demande, p.motif_decision,
              p.date_demande, p.date_decision,
              (SELECT count(*) FROM echeance_pret ep
                WHERE ep.pret_id = p.id
                  AND ep.statut <> 'REGLEE'
                  AND ep.date_echeance < CURRENT_DATE) AS echeances_en_retard
         FROM pret p
         JOIN cycle  c ON c.id = p.cycle_id
         JOIN membre m ON m.id = p.emprunteur_id
        WHERE c.groupe_id = $1
        ORDER BY p.date_demande DESC`,
      [session.groupe_id],
    );
  }

  /** F-PRE-03 — échéancier d'un prêt. */
  async echeancier(
    session: Session,
    pretId: string,
  ): Promise<LigneEcheancePret[]> {
    await this.exigerPretDuGroupe(session, pretId);

    return this.base.requete<LigneEcheancePret & Record<string, unknown>>(
      `SELECT ep.id, ep.numero, ep.date_echeance, ep.montant_capital,
              ep.montant_interet, ep.montant_regle, ep.statut
         FROM echeance_pret ep
        WHERE ep.pret_id = $1
        ORDER BY ep.numero`,
      [pretId],
    );
  }

  /** R-06 — avoir mobilisable, recalculé depuis le journal. */
  async avoirDisponible(session: Session): Promise<{ avoir: string }> {
    const ligne = await this.base.requeteUne<{ avoir: string }>(
      `SELECT avoir_disponible($1) AS avoir`,
      [session.groupe_id],
    );
    return ligne!;
  }

  /** F-PRE-01 — demande de prêt. */
  async demander(
    session: Session,
    montant: number,
    motif: string,
    nombreEcheances: number,
    emprunteurId?: string,
  ): Promise<{ id: string }> {
    const cycle = await this.cycleOuvert(session);

    // Par défaut on emprunte pour soi. Un président peut déposer une demande
    // au nom d'un membre qui ne se connecte pas — cas courant, beaucoup de
    // membres n'ont pas de compte (modèle §7).
    const pour = emprunteurId ?? session.membre_id;

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
        `SELECT demander_pret($1, $2, $3, $4, $5) AS id`,
        [cycle, pour, montant, motif, nombreEcheances],
      );
      return ligne!;
    } catch (erreur) {
      this.traduire(erreur);
    }
  }

  /** F-PRE-02, R-06 — approuve et octroie en une transaction. */
  async approuver(
    session: Session,
    pretId: string,
    montant: number,
  ): Promise<Record<string, unknown>> {
    await this.exigerPretDuGroupe(session, pretId);

    try {
      const lignes = await this.base.requete(
        `SELECT * FROM approuver_pret($1, $2, $3)`,
        [pretId, montant, session.membre_id],
      );
      return lignes[0];
    } catch (erreur) {
      this.traduire(erreur);
    }
  }

  /** F-PRE-02 — refus motivé. */
  async refuser(
    session: Session,
    pretId: string,
    motif: string,
  ): Promise<{ statut: string }> {
    await this.exigerPretDuGroupe(session, pretId);

    try {
      const ligne = await this.base.requeteUne<{ statut: string }>(
        `SELECT refuser_pret($1, $2, $3) AS statut`,
        [pretId, motif, session.membre_id],
      );
      return ligne!;
    } catch (erreur) {
      this.traduire(erreur);
    }
  }

  /** F-PRE-04, F-PRE-05 — remboursement, capital et intérêt séparés. */
  async rembourser(
    session: Session,
    pretId: string,
    capital: number,
    interet: number,
    date: string,
    moyen: string,
  ): Promise<Record<string, unknown>> {
    await this.exigerPretDuGroupe(session, pretId);

    try {
      const lignes = await this.base.requete(
        `SELECT * FROM enregistrer_remboursement($1, $2, $3, $4, $5::moyen_paiement, $6)`,
        [pretId, capital, interet, date, moyen, session.membre_id],
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
      throw new BadRequestException(
        'Aucun cycle ouvert — le président doit en ouvrir un',
      );
    }
    return ligne.id;
  }

  /**
   * Cloisonnement (N-SEC-02). Un prêt d'un autre groupe est rendu INTROUVABLE,
   * jamais décrit : répondre « interdit » révélerait son existence.
   */
  private async exigerPretDuGroupe(
    session: Session,
    pretId: string,
  ): Promise<void> {
    const trouve = await this.base.requeteUne<{ existe: boolean }>(
      `SELECT true AS existe
         FROM pret p JOIN cycle c ON c.id = p.cycle_id
        WHERE p.id = $1 AND c.groupe_id = $2`,
      [pretId, session.groupe_id],
    );

    if (!trouve) {
      throw new NotFoundException('Prêt introuvable');
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

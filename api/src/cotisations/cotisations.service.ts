/**
 * Cotisations — F-COT-02 à F-COT-05, F-COT-07.
 *
 * CE SERVICE N'ÉCRIT AUCUN SQL D'ÉCRITURE COMPTABLE. Il appelle les fonctions
 * de la migration 005, qui sont atomiques par construction : `enregistrer_versement`
 * insère l'écriture, ses lignes et la cotisation dans une seule transaction. Le
 * déclencheur d'équilibre étant différé au COMMIT (R-01), reconstituer ce
 * séquencement ici exposerait à l'oublier — et une écriture incomplète serait
 * rejetée, ou pire, une cotisation existerait sans écriture.
 *
 * LE GROUPE VIENT TOUJOURS DE LA SESSION (N-SEC-03). Aucune méthode n'accepte
 * un `groupe_id` en paramètre : il est lu dans le jeton et vérifié contre la
 * ressource visée.
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

// Exportées car `declaration: true` exige que tout type de retour public soit
// nommable depuis l'extérieur du module : un contrôleur qui renvoie ces formes
// ne compilerait pas si elles restaient privées.
export interface LigneVersement {
  cotisation_id: string;
  ecriture_id: string;
  ecriture_numero: string;
  montant_regle: string;
  reliquat: string;
  statut: string;
}

export interface LigneImpaye {
  echeance_id: string;
  membre_id: string;
  nom_complet: string;
  telephone: string;
  date_echeance: string;
  montant_attendu: string;
  montant_regle: string;
  reste_du: string;
  jours_retard: number;
  statut: string;
  motif_dispense: string | null;
  tour_rang: number | null;
}

@Injectable()
export class CotisationsService {
  constructor(private readonly base: BaseService) {}

  /**
   * Traduit une erreur PostgreSQL en réponse HTTP porteuse de sens.
   *
   * Les fonctions SQL lèvent des messages déjà rédigés pour un humain — « Le
   * versement de 25000 F dépasse le reste dû de 15000 F ». Les relayer tels
   * quels vaut mieux que de les remplacer par un message générique : le
   * trésorier saisit un montant, il doit comprendre ce qui est refusé.
   *
   * Seul `internal_error` est masqué : un déséquilibre comptable est un défaut
   * du service, jamais une erreur de l'utilisateur (N-USG-05).
   */
  private traduire(erreur: unknown): never {
    if (erreur instanceof DatabaseError) {
      const message = erreur.message;

      switch (erreur.code) {
        case 'no_data_found':
        case 'P0002':
          throw new NotFoundException(message);
        case '42501': // insufficient_privilege
          throw new ForbiddenException(message);
        case '23514': // check_violation
        case '23505': // unique_violation
        case '23503': // foreign_key_violation
          throw new BadRequestException(message);
        default:
          break;
      }
    }
    throw erreur;
  }

  /** F-COT-04 — échéances non soldées du groupe. */
  async impayes(session: Session, cycleId?: string): Promise<LigneImpaye[]> {
    return this.base.requete<LigneImpaye & Record<string, unknown>>(
      `SELECT echeance_id, membre_id, nom_complet, telephone, date_echeance,
              montant_attendu, montant_regle, reste_du, jours_retard,
              statut, motif_dispense, tour_rang
         FROM v_impaye
        WHERE groupe_id = $1
          AND ($2::UUID IS NULL OR cycle_id = $2)
        ORDER BY date_echeance, nom_complet`,
      [session.groupe_id, cycleId ?? null],
    );
  }

  /** F-COT-02, F-COT-03 — enregistre un versement reçu hors application. */
  async enregistrer(
    session: Session,
    echeanceId: string,
    montant: number,
    dateVersement: string,
    moyen: string,
    referenceExterne?: string,
  ): Promise<LigneVersement> {
    // Cloisonnement vérifié AVANT l'appel : la fonction SQL le contrôlerait
    // aussi, mais son message parlerait de groupes et d'UUID. Ici on peut dire
    // simplement que l'échéance n'existe pas — ce qui est vrai du point de vue
    // de l'appelant, et ne révèle pas l'existence d'une ressource d'un autre
    // groupe (N-SEC-02).
    await this.exigerEcheanceDuGroupe(session, echeanceId);

    try {
      const lignes = await this.base.requete<LigneVersement>(
        `SELECT * FROM enregistrer_versement($1, $2, $3, $4::moyen_paiement, $5, $6)`,
        [
          echeanceId,
          montant,
          dateVersement,
          moyen,
          session.membre_id,
          referenceExterne ?? null,
        ],
      );
      return lignes[0];
    } catch (erreur) {
      this.traduire(erreur);
    }
  }

  /** F-COT-05 — annule par écriture inverse. L'originale reste au journal. */
  async annuler(
    session: Session,
    cotisationId: string,
    motif: string,
  ): Promise<Record<string, unknown>> {
    const appartient = await this.base.requeteUne<{ existe: boolean }>(
      `SELECT true AS existe
         FROM cotisation c
         JOIN ecriture e ON e.id = c.ecriture_id
        WHERE c.id = $1 AND e.groupe_id = $2`,
      [cotisationId, session.groupe_id],
    );

    if (!appartient) {
      throw new NotFoundException('Versement introuvable');
    }

    try {
      const lignes = await this.base.requete(
        `SELECT * FROM annuler_versement($1, $2, $3)`,
        [cotisationId, motif, session.membre_id],
      );
      return lignes[0];
    } catch (erreur) {
      this.traduire(erreur);
    }
  }

  /** F-COT-07 — dispense accordée par le président, motif obligatoire. */
  async dispenser(
    session: Session,
    echeanceId: string,
    motif: string,
  ): Promise<{ statut: string }> {
    await this.exigerEcheanceDuGroupe(session, echeanceId);

    try {
      const ligne = await this.base.requeteUne<{ statut: string }>(
        `SELECT dispenser_echeance($1, $2, $3) AS statut`,
        [echeanceId, motif, session.membre_id],
      );
      return ligne!;
    } catch (erreur) {
      this.traduire(erreur);
    }
  }

  /** F-RAP-01 — relevé d'un membre, en langage courant (N-USG-05). */
  async releve(
    session: Session,
    membreId: string,
  ): Promise<Record<string, unknown>[]> {
    return this.base.requete(
      `SELECT date_versement, montant, moyen, reference_externe,
              date_echeance, montant_attendu, operation_numero, annule
         FROM v_historique_membre
        WHERE groupe_id = $1 AND membre_id = $2
        ORDER BY date_versement DESC, operation_numero DESC`,
      [session.groupe_id, membreId],
    );
  }

  private async exigerEcheanceDuGroupe(
    session: Session,
    echeanceId: string,
  ): Promise<void> {
    const trouvee = await this.base.requeteUne<{ existe: boolean }>(
      `SELECT true AS existe
         FROM echeance e
         JOIN cycle c ON c.id = e.cycle_id
        WHERE e.id = $1 AND c.groupe_id = $2`,
      [echeanceId, session.groupe_id],
    );

    if (!trouvee) {
      throw new NotFoundException('Échéance introuvable');
    }
  }
}

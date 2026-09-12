/**
 * Anomalies — F-ANO.
 *
 * UNE ANOMALIE EST UN SIGNALEMENT, JAMAIS UNE ACCUSATION. Le vocabulaire de ce
 * service et des messages qu'il relaie le reflète : « à vérifier », jamais
 * « fraude ». Une tontine repose sur la confiance ; un outil qui désignerait un
 * coupable détruirait ce qu'il prétend protéger.
 *
 * LE BALAYAGE NE BLOQUE JAMAIS UNE SAISIE (N-PRF-03). Il est déclenché
 * explicitement ou par tâche de fond, jamais dans la transaction d'un
 * versement.
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

export interface LigneAnomalie {
  id: string;
  type: string;
  gravite: string;
  statut: string;
  description: string;
  donnees: Record<string, unknown>;
  detectee_le: string;
  membre_id: string | null;
  membre: string | null;
}

export interface Balayage {
  cotisations_manquantes: number;
  soldes_incoherents: number;
  doubles_saisies: number;
  saisies_tardives: number;
  remboursements_retard: number;
  montants_inhabituels: number;
}

@Injectable()
export class AnomaliesService {
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
          throw new BadRequestException(erreur.message);
        default:
          break;
      }
    }
    throw erreur;
  }

  /** F-TDB-04 — anomalies à vérifier, les plus graves d'abord. */
  async ouvertes(session: Session): Promise<LigneAnomalie[]> {
    return this.base.requete<LigneAnomalie & Record<string, unknown>>(
      `SELECT id, type, gravite, statut, description, donnees,
              detectee_le, membre_id, membre
         FROM v_anomalie_ouverte
        WHERE groupe_id = $1`,
      [session.groupe_id],
    );
  }

  /**
   * Anomalies levées — la piste d'audit.
   *
   * LEVER N'EST PAS EFFACER. Une anomalie levée sort du tableau de bord mais
   * reste au dossier avec son motif et son décideur. Savoir qu'un écart a été
   * constaté PUIS justifié vaut souvent plus que l'écart lui-même.
   */
  async levees(session: Session): Promise<Record<string, unknown>[]> {
    return this.base.requete(
      `SELECT a.id, a.type, a.gravite, a.description, a.detectee_le,
              a.motif_levee, a.levee_le, m.nom_complet AS levee_par
         FROM anomalie a
         LEFT JOIN membre m ON m.id = a.levee_par
        WHERE a.groupe_id = $1 AND a.statut = 'LEVEE'
        ORDER BY a.levee_le DESC`,
      [session.groupe_id],
    );
  }

  /** Balayage complet du groupe. */
  async balayer(session: Session): Promise<Balayage> {
    const ligne = await this.base.requeteUne<Balayage & Record<string, unknown>>(
      `SELECT * FROM balayer_anomalies($1)`,
      [session.groupe_id],
    );
    return ligne!;
  }

  /**
   * F-ANO-08 — lève une anomalie, motif obligatoire.
   *
   * La fonction SQL réserve en outre la levée d'une anomalie CRITIQUE au
   * commissaire aux comptes (F-ANO-09), afin qu'un écart sérieux ne soit jamais
   * levé par la personne dont la saisie est en cause.
   */
  async lever(
    session: Session,
    anomalieId: string,
    motif: string,
  ): Promise<{ statut: string }> {
    const trouve = await this.base.requeteUne<{ existe: boolean }>(
      `SELECT true AS existe FROM anomalie
        WHERE id = $1 AND groupe_id = $2`,
      [anomalieId, session.groupe_id],
    );

    if (!trouve) {
      throw new NotFoundException('Anomalie introuvable');
    }

    try {
      const ligne = await this.base.requeteUne<{ statut: string }>(
        `SELECT lever_anomalie($1, $2, $3) AS statut`,
        [anomalieId, motif, session.membre_id],
      );
      return ligne!;
    } catch (erreur) {
      this.traduire(erreur);
    }
  }
}

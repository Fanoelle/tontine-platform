/**
 * Notifications — F-NOT-01 à F-NOT-06, F-COT-06, F-ANO-09.
 *
 * LE SERVICE NE DÉCIDE PAS DU CONTENU DES MESSAGES. Ils sont composés par les
 * fonctions SQL (migration 015), au plus près des données qu'ils citent : un
 * rappel qui annonce « il reste 15 000 F » doit lire ce chiffre là où il est
 * calculé, pas le recevoir d'une couche qui pourrait l'avoir périmé.
 *
 * L'ENVOI EST SÉPARÉ DE LA MISE EN FILE, et c'est la propriété structurante :
 * un versement saisi à 23 h met en file un accusé qui partira le matin
 * (F-NOT-06), sans jamais retarder la saisie elle-même (N-PRF-03).
 */
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BaseService } from '../base/base.service';
import type { Session } from '../authentification/session';
import {
  EXPEDITEUR,
  type Expediteur,
  type MessageAExpedier,
} from './expediteur';

export interface LigneNotification {
  id: string;
  type: string;
  canal: string;
  statut: string;
  adresse: string;
  objet: string;
  corps: string;
  destinataire: string;
  envoyable_a: string;
  envoyee_le: string | null;
  tentatives: number;
  derniere_erreur: string | null;
  cree_le: string;
}

export interface ResultatBalayage {
  rappels_avant: number;
  rappels_retard: number;
  alertes_anomalie: number;
}

export interface ResultatExpedition {
  traitees: number;
  envoyees: number;
  echouees: number;
  expediteur: string;
}

/** Bilan d'un passage du planificateur sur l'ensemble des groupes actifs. */
export interface ResultatBalayageGlobal {
  groupes: number;
  rappels_avant: number;
  rappels_retard: number;
  alertes_anomalie: number;
  envoyees: number;
  echouees: number;
  /** Les groupes dont le balayage a échoué, nommés — pour qu'on puisse agir. */
  erreurs: { groupe: string; motif: string }[];
}

@Injectable()
export class NotificationsService {
  private readonly journal = new Logger(NotificationsService.name);

  constructor(
    private readonly base: BaseService,
    @Inject(EXPEDITEUR) private readonly expediteur: Expediteur,
  ) {}

  /** File du groupe, la plus récente d'abord. */
  async lister(
    session: Session,
    statut?: string,
  ): Promise<LigneNotification[]> {
    return this.base.requete<LigneNotification & Record<string, unknown>>(
      `SELECT n.id, n.type::TEXT, n.canal::TEXT, n.statut::TEXT, n.adresse,
              n.objet, n.corps, m.nom_complet AS destinataire,
              n.envoyable_a, n.envoyee_le, n.tentatives, n.derniere_erreur,
              n.cree_le
         FROM notification n
         JOIN membre m ON m.id = n.destinataire_id
        WHERE n.groupe_id = $1
          AND ($2::TEXT IS NULL OR n.statut::TEXT = $2)
        ORDER BY n.cree_le DESC
        LIMIT 200`,
      [session.groupe_id, statut ?? null],
    );
  }

  /** Ce qu'un membre a reçu — sa propre trace, consultable par lui. */
  async mesNotifications(session: Session): Promise<LigneNotification[]> {
    return this.base.requete<LigneNotification & Record<string, unknown>>(
      `SELECT n.id, n.type::TEXT, n.canal::TEXT, n.statut::TEXT, n.adresse,
              n.objet, n.corps, m.nom_complet AS destinataire,
              n.envoyable_a, n.envoyee_le, n.tentatives, n.derniere_erreur,
              n.cree_le
         FROM notification n
         JOIN membre m ON m.id = n.destinataire_id
        WHERE n.destinataire_id = $1
        ORDER BY n.cree_le DESC
        LIMIT 50`,
      [session.membre_id],
    );
  }

  /**
   * Balayage : met en file les rappels et les alertes.
   *
   * Appelé par une tâche de fond ou manuellement. Il ne bloque aucune saisie
   * (N-PRF-03) et peut être rejoué sans risque : la déduplication est portée
   * par des index uniques partiels, non par ce code.
   */
  async balayer(
    session: Session,
    joursAvant = 3,
  ): Promise<ResultatBalayage> {
    const rappels = await this.base.requeteUne<{
      rappels_avant: number;
      rappels_retard: number;
    }>(`SELECT * FROM preparer_rappels($1, $2)`, [
      session.groupe_id,
      joursAvant,
    ]);

    const alertes = await this.base.requeteUne<{ alertes: string }>(
      `SELECT alerter_anomalies($1) AS alertes`,
      [session.groupe_id],
    );

    return {
      rappels_avant: Number(rappels?.rappels_avant ?? 0),
      rappels_retard: Number(rappels?.rappels_retard ?? 0),
      alertes_anomalie: Number(alertes?.alertes ?? 0),
    };
  }

  /** F-NOT-02 — accusé de réception d'un versement. */
  async accuserVersement(
    session: Session,
    cotisationId: string,
  ): Promise<{ id: string | null }> {
    const appartient = await this.base.requeteUne<{ existe: boolean }>(
      `SELECT true AS existe
         FROM cotisation c
         JOIN echeance e ON e.id = c.echeance_id
         JOIN cycle   cy ON cy.id = e.cycle_id
        WHERE c.id = $1 AND cy.groupe_id = $2`,
      [cotisationId, session.groupe_id],
    );

    if (!appartient) {
      throw new NotFoundException('Versement introuvable');
    }

    const ligne = await this.base.requeteUne<{ id: string | null }>(
      `SELECT accuser_versement($1) AS id`,
      [cotisationId],
    );
    return ligne!;
  }

  /**
   * Vide la file des messages dont l'heure est venue.
   *
   * CHAQUE MESSAGE EST TRAITÉ SÉPARÉMENT, et un échec n'interrompt pas les
   * suivants : une adresse erronée ne doit pas empêcher les autres membres
   * d'être prévenus. L'échec est consigné et rejoué plus tard, jusqu'à cinq
   * tentatives.
   */
  async expedierEnAttente(session: Session): Promise<ResultatExpedition> {
    return this.viderLaFile(session.groupe_id);
  }

  /**
   * Balaye TOUS les groupes — réservé au planificateur, sans session.
   *
   * POURQUOI UNE MÉTHODE SÉPARÉE PLUTÔT QU'UN `groupe_id` FACULTATIF. Une route
   * HTTP tire toujours son groupe du jeton (N-SEC-03) ; un paramètre optionnel
   * ouvrirait la porte à un appel sans groupe depuis un contrôleur, et
   * l'isolation reposerait alors sur la vigilance de chaque auteur de route.
   * Deux méthodes aux noms distincts rendent le franchissement visible.
   */
  async balayerTousLesGroupes(joursAvant = 3): Promise<ResultatBalayageGlobal> {
    const groupes = await this.base.requete<{ id: string; nom: string }>(
      // Les groupes ARCHIVÉS sont écartés : leur cycle est clos, leurs comptes
      // soldés, et un rappel d'échéance y serait au mieux absurde.
      `SELECT id, nom FROM groupe WHERE NOT archive ORDER BY nom`,
    );

    const resultat: ResultatBalayageGlobal = {
      groupes: 0,
      rappels_avant: 0,
      rappels_retard: 0,
      alertes_anomalie: 0,
      envoyees: 0,
      echouees: 0,
      erreurs: [],
    };

    for (const groupe of groupes) {
      // UN GROUPE EN PANNE N'ARRÊTE PAS LES AUTRES. Une donnée incohérente dans
      // un groupe — un cycle sans tour, une échéance orpheline — ne doit pas
      // priver les onze autres de leurs rappels.
      try {
        const rappels = await this.base.requeteUne<{
          rappels_avant: number;
          rappels_retard: number;
        }>(`SELECT * FROM preparer_rappels($1, $2)`, [groupe.id, joursAvant]);

        const alertes = await this.base.requeteUne<{ alertes: string }>(
          `SELECT alerter_anomalies($1) AS alertes`,
          [groupe.id],
        );

        const expedition = await this.viderLaFile(groupe.id);

        resultat.groupes += 1;
        resultat.rappels_avant += Number(rappels?.rappels_avant ?? 0);
        resultat.rappels_retard += Number(rappels?.rappels_retard ?? 0);
        resultat.alertes_anomalie += Number(alertes?.alertes ?? 0);
        resultat.envoyees += expedition.envoyees;
        resultat.echouees += expedition.echouees;
      } catch (erreur) {
        resultat.erreurs.push({
          groupe: groupe.nom,
          motif: (erreur as Error).message,
        });
        this.journal.error(
          `Balayage du groupe « ${groupe.nom} » interrompu : `
            + `${(erreur as Error).message}`,
        );
      }
    }

    return resultat;
  }

  private async viderLaFile(groupeId: string): Promise<ResultatExpedition> {
    const messages = await this.base.requete<
      MessageAExpedier & Record<string, unknown>
    >(
      `SELECT id, canal::TEXT, adresse, objet, corps, destinataire
         FROM v_notification_a_envoyer
        WHERE groupe_id = $1
        LIMIT 100`,
      [groupeId],
    );

    let envoyees = 0;
    let echouees = 0;

    for (const message of messages) {
      try {
        const resultat = await this.expediteur.expedier(message);

        if (resultat.reussi) {
          await this.base.requete(`SELECT marquer_envoyee($1)`, [message.id]);
          envoyees += 1;
        } else {
          await this.base.requete(`SELECT marquer_echouee($1, $2)`, [
            message.id,
            resultat.erreur ?? 'échec sans motif',
          ]);
          echouees += 1;
        }
      } catch (erreur) {
        // Une exception de l'expéditeur est un échec comme un autre : on la
        // consigne et on passe au message suivant. Laisser remonter arrêterait
        // le traitement de toute la file sur un seul destinataire.
        await this.base.requete(`SELECT marquer_echouee($1, $2)`, [
          message.id,
          (erreur as Error).message,
        ]);
        echouees += 1;
      }
    }

    if (messages.length > 0) {
      this.journal.log(
        `File traitée via « ${this.expediteur.nom} » : ` +
          `${envoyees} envoyée(s), ${echouees} en échec`,
      );
    }

    return {
      traitees: messages.length,
      envoyees,
      echouees,
      expediteur: this.expediteur.nom,
    };
  }
}

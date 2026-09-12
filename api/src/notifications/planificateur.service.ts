/**
 * Planificateur — F-NOT-01 sans intervention humaine.
 *
 * LE PROBLÈME QU'IL RÉSOUT. Jusqu'ici, les rappels ne partaient que si
 * quelqu'un cliquait « Balayer ». Or le trésorier qui oublie de cliquer est
 * exactement celui dont le groupe a besoin de rappels : un mécanisme qui exige
 * la vigilance de celui qu'il assiste ne sert à rien.
 *
 * POURQUOI `setInterval` ET NON `@nestjs/schedule`. Le registre npm est
 * injoignable depuis cet environnement, et ajouter une dépendance
 * non installable rendrait le projet non démarrable. `@nestjs/schedule` aurait
 * apporté la syntaxe cron ; ici, un intervalle fixe suffit — les rappels d'une
 * tontine n'ont pas besoin d'une granularité à la minute près, et la plage
 * horaire décente est déjà portée par le SQL (`prochaine_heure_decente`).
 *
 * CE QU'IL NE DÉCIDE PAS. Ni l'heure d'envoi de chaque message — c'est la file
 * qui la porte — ni le contenu. Il se contente de réveiller la mécanique
 * existante à intervalle régulier. C'est ce qui le rend sûr à rejouer : un
 * passage supplémentaire ne produit aucun doublon, la déduplication étant
 * assurée par des index uniques partiels en base.
 */
import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';

@Injectable()
export class PlanificateurService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly journal = new Logger('Planificateur');

  private minuteur: NodeJS.Timeout | null = null;

  /**
   * Garde-fou contre le CHEVAUCHEMENT. Un balayage lent — beaucoup de groupes,
   * un serveur SMTP poussif — pourrait déborder sur le suivant. Deux passages
   * simultanés se disputeraient les mêmes messages, et la file compterait des
   * tentatives qui n'en sont pas.
   */
  private enCours = false;

  private readonly intervalleMs: number;
  private readonly joursAvant: number;
  private readonly actif: boolean;

  constructor(
    private readonly notifications: NotificationsService,
    config: ConfigService,
  ) {
    // ACTIF PAR DÉFAUT. Un rappel automatique qu'il faut penser à activer
    // reproduit le problème qu'il corrige. On le désactive explicitement, pour
    // les tests ou pour une instance de secours qui ne doit pas doubler les
    // envois de l'instance principale.
    this.actif = config.get<string>('RAPPELS_AUTOMATIQUES') !== 'non';

    const minutes = Number.parseInt(
      config.get<string>('RAPPELS_INTERVALLE_MINUTES') ?? '30',
      10,
    );
    // Bornes : sous 5 minutes on interroge la base pour rien, au-delà de 12
    // heures un message mis en file le matin partirait le soir.
    const borne = Number.isInteger(minutes) ? Math.min(Math.max(minutes, 5), 720) : 30;
    this.intervalleMs = borne * 60_000;

    const jours = Number.parseInt(
      config.get<string>('RAPPELS_JOURS_AVANT') ?? '3',
      10,
    );
    this.joursAvant = Number.isInteger(jours) && jours >= 1 && jours <= 15 ? jours : 3;
  }

  onApplicationBootstrap(): void {
    if (!this.actif) {
      this.journal.log(
        'Rappels automatiques DÉSACTIVÉS (RAPPELS_AUTOMATIQUES=non). '
          + 'Le balayage manuel reste disponible.',
      );
      return;
    }

    this.journal.log(
      `Rappels automatiques actifs : un passage toutes les `
        + `${this.intervalleMs / 60_000} min, préavis de ${this.joursAvant} jours.`,
    );

    // `unref()` : ce minuteur ne doit pas à lui seul maintenir le processus en
    // vie. Sans cela, un `kill` poli attendrait la fin de l'intervalle.
    this.minuteur = setInterval(() => void this.passer(), this.intervalleMs);
    this.minuteur.unref();

    // PREMIER PASSAGE DIFFÉRÉ DE QUELQUES SECONDES, et non immédiat : au
    // démarrage, le pool de connexions vient de s'ouvrir et les migrations
    // peuvent être en cours. Rien ne presse — la file porte déjà l'heure
    // d'envoi de chaque message.
    const amorce = setTimeout(() => void this.passer(), 10_000);
    amorce.unref();
  }

  onApplicationShutdown(): void {
    if (this.minuteur) {
      clearInterval(this.minuteur);
      this.minuteur = null;
    }
  }

  /**
   * Un passage : met en file ce qui doit l'être, puis expédie ce qui est dû.
   *
   * NE LÈVE JAMAIS. Une exception échappée d'un `setInterval` termine le
   * processus Node — l'API entière tomberait parce qu'un rappel n'a pas pu
   * être calculé. Tout est attrapé et consigné.
   */
  async passer(): Promise<void> {
    if (this.enCours) {
      this.journal.warn(
        'Passage précédent encore en cours — celui-ci est sauté. '
          + 'Si cela se répète, allongez RAPPELS_INTERVALLE_MINUTES.',
      );
      return;
    }

    this.enCours = true;
    const debut = Date.now();

    try {
      const bilan = await this.notifications.balayerTousLesGroupes(
        this.joursAvant,
      );

      const misEnFile =
        bilan.rappels_avant + bilan.rappels_retard + bilan.alertes_anomalie;

      // ON NE JOURNALISE QUE S'IL S'EST PASSÉ QUELQUE CHOSE. Un passage vide
      // toutes les trente minutes noierait les journaux, et c'est dans les
      // journaux qu'on cherche la trace d'un envoi contesté.
      if (misEnFile > 0 || bilan.envoyees > 0 || bilan.echouees > 0) {
        this.journal.log(
          `${bilan.groupes} groupe(s) en ${Date.now() - debut} ms — `
            + `${bilan.rappels_avant} préavis, ${bilan.rappels_retard} relances, `
            + `${bilan.alertes_anomalie} alertes ; `
            + `${bilan.envoyees} envoyée(s), ${bilan.echouees} en échec.`,
        );
      }

      for (const erreur of bilan.erreurs) {
        this.journal.error(`Groupe « ${erreur.groupe} » : ${erreur.motif}`);
      }
    } catch (erreur) {
      this.journal.error(
        `Passage interrompu : ${(erreur as Error).message}`,
        (erreur as Error).stack,
      );
    } finally {
      this.enCours = false;
    }
  }
}

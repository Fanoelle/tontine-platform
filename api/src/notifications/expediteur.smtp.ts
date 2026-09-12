/**
 * Expéditeur SMTP — F-NOT-04, envoi réel par courriel.
 *
 * IL NE S'ACTIVE QUE SI `SMTP_HOTE` EST RENSEIGNÉ. Sans configuration, le
 * module retombe sur l'expéditeur de journal, qui ne prétend rien envoyer. Un
 * projet cloné sans `.env` démarre donc sans erreur et sans illusion.
 *
 * LES CANAUX NON COURRIEL SONT REFUSÉS EXPLICITEMENT. Une notification WhatsApp
 * confiée à un expéditeur SMTP ne doit pas être marquée « envoyée » : elle est
 * mise en échec avec un motif lisible, reste dans la file, et repartira le jour
 * où une passerelle WhatsApp sera branchée. Le silence serait pire que l'échec.
 */
import { Logger } from '@nestjs/common';
import {
  type Expediteur,
  type MessageAExpedier,
  type ResultatExpedition,
} from './expediteur';
import {
  ErreurSmtp,
  envoyerCourriel,
  type ConfigurationSmtp,
} from './smtp.client';

/**
 * Construit la configuration depuis l'environnement, ou rend `null`.
 *
 * `null` n'est pas une erreur : c'est le cas normal d'un poste de
 * développement. L'appelant choisit alors l'expéditeur de journal.
 */
export function configurationDepuisEnvironnement(
  env: NodeJS.ProcessEnv = process.env,
): ConfigurationSmtp | null {
  const hote = env.SMTP_HOTE?.trim();
  if (!hote) return null;

  const port = Number.parseInt(env.SMTP_PORT ?? '587', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `SMTP_PORT invalide : « ${env.SMTP_PORT} ». Attendu un port entre 1 et 65535.`,
    );
  }

  const expediteur = env.SMTP_EXPEDITEUR?.trim();
  if (!expediteur) {
    // Échouer au démarrage plutôt qu'à l'envoi. Une adresse d'expéditeur
    // manquante ferait rejeter chaque message par le serveur, et l'erreur
    // n'apparaîtrait qu'en fin de file, membre par membre.
    throw new Error(
      'SMTP_HOTE est renseigné mais SMTP_EXPEDITEUR manque — '
        + 'indiquez l\'adresse au nom de laquelle les messages partent.',
    );
  }

  const utilisateur = env.SMTP_UTILISATEUR?.trim() || undefined;
  const motDePasse = env.SMTP_MOT_DE_PASSE || undefined;

  if (Boolean(utilisateur) !== Boolean(motDePasse)) {
    throw new Error(
      'SMTP_UTILISATEUR et SMTP_MOT_DE_PASSE vont par paire — '
        + 'renseignez les deux, ou aucun des deux.',
    );
  }

  return {
    hote,
    port,
    // 465 est le port historique du TLS implicite ; 587 et 25 passent par
    // STARTTLS. On suit cette convention, et `SMTP_TLS` permet de la forcer.
    tlsImplicite: env.SMTP_TLS ? env.SMTP_TLS === 'implicite' : port === 465,
    utilisateur,
    motDePasse,
    expediteur,
    nomClient: env.SMTP_NOM_CLIENT?.trim() || 'tontine.local',
    delaiMs: Number.parseInt(env.SMTP_DELAI_MS ?? '15000', 10),
    // Défaut STRICT. Accepter un certificat invalide sans le dire reviendrait à
    // annoncer un envoi chiffré qui ne protège de rien.
    accepterCertificatInvalide: env.SMTP_CERTIFICAT_NON_VERIFIE === 'oui',
  };
}

export class ExpediteurSmtp implements Expediteur {
  readonly nom: string;

  private readonly journal = new Logger(ExpediteurSmtp.name);

  constructor(private readonly config: ConfigurationSmtp) {
    this.nom = `SMTP ${config.hote}:${config.port}`;

    if (config.accepterCertificatInvalide) {
      // Une seule ligne, au démarrage, mais impossible à manquer : une
      // configuration de test laissée en production doit se voir.
      this.journal.warn(
        'SMTP_CERTIFICAT_NON_VERIFIE=oui — les certificats ne sont PAS '
          + 'vérifiés. Acceptable pour un serveur de test local, jamais en '
          + 'production.',
      );
    }
  }

  async expedier(message: MessageAExpedier): Promise<ResultatExpedition> {
    if (message.canal !== 'EMAIL') {
      return {
        reussi: false,
        erreur:
          `Canal ${message.canal} non pris en charge par l'expéditeur SMTP — `
          + 'le message reste en file.',
      };
    }

    try {
      await envoyerCourriel(this.config, {
        destinataire: message.adresse,
        objet: message.objet,
        corps: message.corps,
      });

      return { reussi: true };
    } catch (erreur) {
      const motif =
        erreur instanceof ErreurSmtp
          ? `${erreur.message} (code ${erreur.code}, ` +
            `${erreur.definitive ? 'refus définitif' : 'refus temporaire'})`
          : (erreur as Error).message;

      // Journalisé ici EN PLUS d'être consigné en base : le trésorier lit la
      // file, l'exploitant lit les journaux, et ils ne cherchent pas la même
      // chose. La base garde le motif par message, le journal garde la
      // chronologie.
      this.journal.warn(
        `Échec d'envoi à ${message.adresse} (${message.destinataire}) : ${motif}`,
      );

      return { reussi: false, erreur: motif };
    }
  }
}

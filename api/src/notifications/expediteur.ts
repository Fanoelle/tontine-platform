/**
 * Expédition des notifications — F-NOT-04 (e-mail), F-NOT-05 (WhatsApp).
 *
 * L'EXPÉDITEUR EST ENFICHABLE, ET L'IMPLÉMENTATION FOURNIE N'ENVOIE RIEN.
 *
 * C'est un choix délibéré, pas un oubli. Aucun service SMTP ni aucune passerelle
 * WhatsApp n'est joignable depuis cet environnement, et je ne peux donc éprouver
 * aucun envoi réel. Livrer un code d'envoi non testé serait pire que de ne rien
 * livrer : il donnerait l'illusion que les membres sont prévenus, alors que
 * personne ne saurait dire si un seul message est jamais parti.
 *
 * Ce qui EST livré et éprouvé : la file d'attente, la plage horaire décente, la
 * déduplication, le report progressif, l'abandon après cinq échecs, et la trace
 * de tout cela. Le jour où une passerelle existe, il suffit d'implémenter
 * `Expediteur` — le reste ne bouge pas.
 */

export interface MessageAExpedier {
  id: string;
  canal: 'EMAIL' | 'WHATSAPP' | 'SMS';
  adresse: string;
  objet: string;
  corps: string;
  destinataire: string;
}

export interface ResultatExpedition {
  reussi: boolean;
  erreur?: string;
}

export interface Expediteur {
  /** Nom affiché dans les journaux, pour qu'on sache toujours qui a envoyé. */
  readonly nom: string;
  expedier(message: MessageAExpedier): Promise<ResultatExpedition>;
}

/**
 * Expéditeur de développement : consigne le message et le déclare envoyé.
 *
 * POURQUOI IL DÉCLARE « ENVOYÉ » PLUTÔT QUE D'ÉCHOUER. Un expéditeur qui
 * échouerait systématiquement ferait passer chaque notification par ses cinq
 * tentatives puis l'abandonnerait, remplissant la file de rebut et rendant
 * l'enchaînement invérifiable. En déclarant l'envoi réussi, il permet
 * d'éprouver toute la mécanique — file, plage horaire, déduplication — sans
 * rien prétendre sur le monde extérieur.
 *
 * La trace porte la mention explicite « SIMULÉ » : personne, en lisant les
 * journaux, ne doit croire qu'un message est réellement parti.
 */
export class ExpediteurJournal implements Expediteur {
  readonly nom = 'journal (aucun envoi réel)';

  private readonly envoyes: MessageAExpedier[] = [];

  async expedier(message: MessageAExpedier): Promise<ResultatExpedition> {
    this.envoyes.push(message);

    // eslint-disable-next-line no-console
    console.log(
      `[NOTIFICATION SIMULÉE] ${message.canal} -> ${message.adresse} ` +
        `(${message.destinataire}) : ${message.objet}`,
    );

    return { reussi: true };
  }

  /** Pour les tests : ce que l'expéditeur a vu passer. */
  messagesEnvoyes(): readonly MessageAExpedier[] {
    return this.envoyes;
  }

  vider(): void {
    this.envoyes.length = 0;
  }
}

/** Jeton d'injection : un module fournit l'implémentation, le service l'ignore. */
export const EXPEDITEUR = Symbol('EXPEDITEUR');

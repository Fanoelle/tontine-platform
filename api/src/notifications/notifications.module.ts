import { Logger, Module } from '@nestjs/common';
import { NotificationsControleur } from './notifications.controleur';
import { NotificationsService } from './notifications.service';
import { EXPEDITEUR, ExpediteurJournal, type Expediteur } from './expediteur';
import {
  ExpediteurSmtp,
  configurationDepuisEnvironnement,
} from './expediteur.smtp';
import { PlanificateurService } from './planificateur.service';

/**
 * L'EXPÉDITEUR EST FOURNI ICI, ET NULLE PART AILLEURS.
 *
 * Le service reçoit une interface et ignore tout de l'implémentation. Ni le
 * service, ni les contrôleurs, ni le SQL ne savent si un message part
 * réellement.
 *
 * LE CHOIX SE FAIT À LA CONFIGURATION, PAS À LA COMPILATION. `SMTP_HOTE`
 * renseigné active l'envoi réel ; son absence retombe sur l'expéditeur de
 * journal, qui consigne et annonce « SIMULÉ ».
 *
 * POURQUOI CE REPLI PLUTÔT QU'UNE ERREUR DE DÉMARRAGE. Un développeur qui
 * clone le dépôt n'a pas de serveur de messagerie, et refuser de démarrer
 * l'empêcherait de voir l'application. Le repli est bruyant — une ligne au
 * démarrage dit lequel des deux est actif — et c'est ce qui le rend honnête.
 *
 * UNE ERREUR DE CONFIGURATION, ELLE, ARRÊTE LE DÉMARRAGE. `SMTP_HOTE` sans
 * `SMTP_EXPEDITEUR`, un port hors bornes, un utilisateur sans mot de passe :
 * ce sont des intentions mal exprimées, pas des absences d'intention. Les
 * traiter par un repli silencieux ferait croire à un envoi qui n'aurait
 * jamais lieu.
 */
export function fournirExpediteur(): Expediteur {
  const journal = new Logger('Notifications');
  const configuration = configurationDepuisEnvironnement();

  if (!configuration) {
    journal.log(
      'Aucun SMTP_HOTE : les notifications sont SIMULÉES (rien ne part). '
        + 'Renseignez SMTP_HOTE et SMTP_EXPEDITEUR pour un envoi réel.',
    );
    return new ExpediteurJournal();
  }

  const expediteur = new ExpediteurSmtp(configuration);
  journal.log(`Notifications expédiées par ${expediteur.nom}`);
  return expediteur;
}

@Module({
  controllers: [NotificationsControleur],
  providers: [
    NotificationsService,
    PlanificateurService,
    { provide: EXPEDITEUR, useFactory: fournirExpediteur },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}

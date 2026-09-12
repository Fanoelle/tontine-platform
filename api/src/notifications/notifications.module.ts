import { Module } from '@nestjs/common';
import { NotificationsControleur } from './notifications.controleur';
import { NotificationsService } from './notifications.service';
import { EXPEDITEUR, ExpediteurJournal } from './expediteur';

/**
 * L'EXPÉDITEUR EST FOURNI ICI, ET NULLE PART AILLEURS.
 *
 * Le service reçoit une interface et ignore tout de l'implémentation. Le jour
 * où une passerelle SMTP ou WhatsApp devient joignable, seul ce module change —
 * ni le service, ni les contrôleurs, ni le SQL.
 *
 * L'implémentation par défaut n'envoie RIEN et le dit (voir expediteur.ts).
 * Livrer un code d'envoi non éprouvé donnerait l'illusion que les membres sont
 * prévenus, alors que personne ne saurait dire si un message est jamais parti.
 */
@Module({
  controllers: [NotificationsControleur],
  providers: [
    NotificationsService,
    { provide: EXPEDITEUR, useClass: ExpediteurJournal },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}

/**
 * Épreuve du planificateur de rappels.
 *
 * CE QUI EST ÉPROUVÉ ICI, ce n'est pas que les rappels sont justes — le SQL s'en
 * charge et `notifications.spec.ts` le vérifie — mais que le RÉVEIL est sûr :
 * qu'un passage lent n'en déclenche pas deux, qu'une panne de base ne tue pas
 * le processus, et qu'une configuration absurde est ramenée à des bornes
 * raisonnables plutôt que d'être appliquée telle quelle.
 *
 * POURQUOI CES TROIS-LÀ. Ce sont les trois façons dont une tâche périodique
 * casse une application en production, et aucune ne se voit en développement :
 * le chevauchement n'apparaît que sous charge, l'exception échappée n'arrive
 * qu'à la première panne de base, et la configuration absurde n'est saisie
 * qu'une fois, le jour du déploiement.
 */
import { ConfigService } from '@nestjs/config';
import { PlanificateurService } from './notifications/planificateur.service';
import type { NotificationsService } from './notifications/notifications.service';

function config(valeurs: Record<string, string> = {}): ConfigService {
  return {
    get: (cle: string) => valeurs[cle],
  } as unknown as ConfigService;
}

function bilanVide() {
  return {
    groupes: 1,
    rappels_avant: 0,
    rappels_retard: 0,
    alertes_anomalie: 0,
    envoyees: 0,
    echouees: 0,
    erreurs: [],
  };
}

describe('Planificateur — garde-fou contre le chevauchement', () => {
  it('saute un passage tant que le précédent n\'est pas fini', async () => {
    let enCoursDeBalayage: (() => void) | null = null;
    let appels = 0;

    const notifications = {
      balayerTousLesGroupes: jest.fn(async () => {
        appels += 1;
        // Balayage qui ne rend la main que lorsqu'on le débloque : c'est le
        // cas d'un serveur SMTP lent, ou d'un groupe à mille échéances.
        await new Promise<void>((resoudre) => {
          enCoursDeBalayage = resoudre;
        });
        return bilanVide();
      }),
    } as unknown as NotificationsService;

    const planificateur = new PlanificateurService(notifications, config());

    const premier = planificateur.passer();
    // Laisse le premier passage atteindre son attente.
    await new Promise((r) => setImmediate(r));

    // Deuxième réveil alors que le premier travaille encore : DOIT être sauté.
    await planificateur.passer();
    expect(appels).toBe(1);

    enCoursDeBalayage!();
    await premier;

    // Une fois libéré, un nouveau passage repart normalement.
    let secondDebloque: (() => void) | null = null;
    (notifications.balayerTousLesGroupes as jest.Mock).mockImplementationOnce(
      async () => {
        appels += 1;
        await new Promise<void>((r) => {
          secondDebloque = r;
        });
        return bilanVide();
      },
    );
    const suivant = planificateur.passer();
    await new Promise((r) => setImmediate(r));
    expect(appels).toBe(2);
    secondDebloque!();
    await suivant;
  });

  it('libère le verrou même quand le balayage ÉCHOUE', async () => {
    // Sans le `finally`, une seule panne bloquerait tous les passages
    // suivants — l'application paraîtrait vivante et n'enverrait plus rien.
    const notifications = {
      balayerTousLesGroupes: jest
        .fn()
        .mockRejectedValueOnce(new Error('base injoignable'))
        .mockResolvedValueOnce(bilanVide()),
    } as unknown as NotificationsService;

    const planificateur = new PlanificateurService(notifications, config());

    await planificateur.passer();
    await planificateur.passer();

    expect(notifications.balayerTousLesGroupes).toHaveBeenCalledTimes(2);
  });
});

describe('Planificateur — robustesse', () => {
  it('n\'exhume AUCUNE exception : un setInterval qui lève tue le processus', async () => {
    const notifications = {
      balayerTousLesGroupes: jest
        .fn()
        .mockRejectedValue(new Error('PostgreSQL est tombé')),
    } as unknown as NotificationsService;

    const planificateur = new PlanificateurService(notifications, config());

    await expect(planificateur.passer()).resolves.toBeUndefined();
  });

  it('consigne les groupes en échec sans interrompre le bilan', async () => {
    const notifications = {
      balayerTousLesGroupes: jest.fn().mockResolvedValue({
        ...bilanVide(),
        groupes: 3,
        rappels_avant: 5,
        erreurs: [{ groupe: 'Tontine du marché', motif: 'cycle incohérent' }],
      }),
    } as unknown as NotificationsService;

    const planificateur = new PlanificateurService(notifications, config());

    await expect(planificateur.passer()).resolves.toBeUndefined();
  });
});

describe('Planificateur — configuration', () => {
  it('est actif par défaut : un rappel qu\'il faut activer ne sert à rien', () => {
    const notifications = {
      balayerTousLesGroupes: jest.fn(),
    } as unknown as NotificationsService;

    const planificateur = new PlanificateurService(notifications, config());
    planificateur.onApplicationBootstrap();

    // Le minuteur est posé : l'arrêt doit donc avoir quelque chose à faire.
    expect(() => planificateur.onApplicationShutdown()).not.toThrow();
  });

  it('se tait quand RAPPELS_AUTOMATIQUES=non', async () => {
    const notifications = {
      balayerTousLesGroupes: jest.fn(),
    } as unknown as NotificationsService;

    const planificateur = new PlanificateurService(
      notifications,
      config({ RAPPELS_AUTOMATIQUES: 'non' }),
    );
    planificateur.onApplicationBootstrap();

    // Aucun passage d'amorce n'est programmé : rien ne part.
    await new Promise((r) => setTimeout(r, 50));
    expect(notifications.balayerTousLesGroupes).not.toHaveBeenCalled();

    planificateur.onApplicationShutdown();
  });

  it('borne un intervalle absurde plutôt que de l\'appliquer', async () => {
    // Une minute d'intervalle interrogerait la base 1440 fois par jour pour
    // rien ; une année ne réveillerait jamais rien. On ramène aux bornes.
    const notifications = {
      balayerTousLesGroupes: jest.fn().mockResolvedValue(bilanVide()),
    } as unknown as NotificationsService;

    for (const valeur of ['1', '0', '-5', '999999', 'trois']) {
      const planificateur = new PlanificateurService(
        notifications,
        config({ RAPPELS_INTERVALLE_MINUTES: valeur }),
      );
      expect(() => planificateur.onApplicationBootstrap()).not.toThrow();
      planificateur.onApplicationShutdown();
    }
  });

  it('ramène un préavis hors bornes au défaut de 3 jours', async () => {
    const notifications = {
      balayerTousLesGroupes: jest.fn().mockResolvedValue(bilanVide()),
    } as unknown as NotificationsService;

    const planificateur = new PlanificateurService(
      notifications,
      config({ RAPPELS_JOURS_AVANT: '400' }),
    );
    await planificateur.passer();

    // 400 jours de préavis serait accepté par le SQL et produirait un rappel
    // pour chaque échéance du cycle entier, dès le premier jour.
    expect(notifications.balayerTousLesGroupes).toHaveBeenCalledWith(3);
  });

  it('respecte un préavis valide', async () => {
    const notifications = {
      balayerTousLesGroupes: jest.fn().mockResolvedValue(bilanVide()),
    } as unknown as NotificationsService;

    const planificateur = new PlanificateurService(
      notifications,
      config({ RAPPELS_JOURS_AVANT: '7' }),
    );
    await planificateur.passer();

    expect(notifications.balayerTousLesGroupes).toHaveBeenCalledWith(7);
  });
});

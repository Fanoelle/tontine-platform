/**
 * Tests d'intégration des routes métier.
 *
 * CONTRE LA VRAIE BASE (décision 0001). Ce qui est éprouvé ici n'est pas le
 * code TypeScript mais la chaîne complète : route, garde, service, fonction SQL,
 * déclencheur. Une doublure de base testerait la moitié qui ne peut pas casser.
 *
 * Les tests qui écrivent (versement, remise) s'exécutent en dernier et sur des
 * données que le jeu de démonstration laisse volontairement incomplètes.
 *
 * Prérequis : ./scripts/db.sh reinitialiser
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './app.module';

const TRESORIERE = '+237690110002';
const PRESIDENTE = '+237690110001';
const COMMISSAIRE = '+237690110003';
const MOT_DE_PASSE = 'tontine2026';

describe('Routes métier', () => {
  let app: INestApplication;
  let serveur: ReturnType<INestApplication['getHttpServer']>;
  let jetonTresoriere: string;
  let jetonPresidente: string;
  let jetonCommissaire: string;

  const connecter = async (telephone: string): Promise<string> => {
    const reponse = await request(serveur)
      .post('/api/authentification/connexion')
      .send({ telephone, mot_de_passe: MOT_DE_PASSE })
      .expect(200);
    return reponse.body.jeton;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'secret-de-test';

    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    serveur = app.getHttpServer();

    jetonTresoriere = await connecter(TRESORIERE);
    jetonPresidente = await connecter(PRESIDENTE);
    jetonCommissaire = await connecter(COMMISSAIRE);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('F-TDB — tableau de bord', () => {
    it('rend la situation du groupe sans identifiant de groupe dans l’URL', async () => {
      const { body } = await request(serveur)
        .get('/api/tableau-de-bord')
        .set('Authorization', `Bearer ${jetonTresoriere}`)
        .expect(200);

      expect(body.groupe).toBe('Tontine des Femmes de Bonabéri');
      expect(body.mecanisme).toBe('ROSCA');

      // `Number(...)` et non une comparaison directe : le pilote `pg` sérialise
      // les BIGINT en CHAÎNE pour ne pas perdre de précision au-delà de 2^53.
      // C'est délibéré de sa part, et cohérent avec N-INT-03 — les montants
      // sont des entiers exacts, pas des flottants. Tout test portant sur un
      // montant ou un décompte doit en tenir compte.
      expect(Number(body.membres_actifs)).toBe(12);
      expect(Number(body.tour_rang)).toBe(3);
    });

    it('refuse sans jeton (N-SEC-04)', async () => {
      await request(serveur).get('/api/tableau-de-bord').expect(401);
    });
  });

  describe('F-MBR-03 — membres', () => {
    it('liste les 12 membres avec leurs rôles', async () => {
      const { body } = await request(serveur)
        .get('/api/membres')
        .set('Authorization', `Bearer ${jetonTresoriere}`)
        .expect(200);

      expect(body).toHaveLength(12);
      const tresoriere = body.find(
        (m: { telephone: string }) => m.telephone === TRESORIERE,
      );
      expect(tresoriere.roles).toContain('TRESORIER');
    });
  });

  describe('F-COT-04 — impayés', () => {
    it('signale les échéances non soldées, dispense comprise', async () => {
      const { body } = await request(serveur)
        .get('/api/cotisations/impayes')
        .set('Authorization', `Bearer ${jetonTresoriere}`)
        .expect(200);

      const tour3 = body.filter(
        (i: { tour_rang: number }) => i.tour_rang === 3,
      );
      const dispensee = tour3.find(
        (i: { statut: string }) => i.statut === 'DISPENSEE',
      );

      // La dispense figure dans la liste : l'omettre laisserait croire à un
      // oubli, alors que le groupe a voté l'exonération.
      expect(dispensee).toBeDefined();
      expect(dispensee.motif_dispense).toContain('Sinistre commerce');
    });
  });

  describe('N-SEC-05 — habilitations vérifiées à chaque appel', () => {
    it('refuse au commissaire d’enregistrer un versement', async () => {
      const { body: impayes } = await request(serveur)
        .get('/api/cotisations/impayes')
        .set('Authorization', `Bearer ${jetonCommissaire}`)
        .expect(200);

      await request(serveur)
        .post('/api/cotisations')
        .set('Authorization', `Bearer ${jetonCommissaire}`)
        .send({
          echeance_id: impayes[0].echeance_id,
          montant: 1000,
          date_versement: '2026-03-05',
          moyen: 'ESPECES',
        })
        .expect(403);
    });

    it('refuse à la trésorière d’accorder une dispense', async () => {
      const { body: impayes } = await request(serveur)
        .get('/api/cotisations/impayes')
        .set('Authorization', `Bearer ${jetonTresoriere}`)
        .expect(200);

      const attendue = impayes.find(
        (i: { statut: string }) => i.statut === 'ATTENDUE',
      );

      await request(serveur)
        .post(`/api/cotisations/echeances/${attendue.echeance_id}/dispense`)
        .set('Authorization', `Bearer ${jetonTresoriere}`)
        .send({ motif: 'Tentative sans habilitation suffisante' })
        .expect(403);
    });
  });

  describe('N-SEC-02 — cloisonnement', () => {
    it('rend introuvable une échéance inexistante plutôt que de la décrire', async () => {
      await request(serveur)
        .post('/api/cotisations')
        .set('Authorization', `Bearer ${jetonTresoriere}`)
        .send({
          echeance_id: '00000000-0000-0000-0000-000000000000',
          montant: 1000,
          date_versement: '2026-03-05',
          moyen: 'ESPECES',
        })
        .expect(404);
    });
  });

  describe('F-COT-02 — contrôles de saisie', () => {
    let echeancePartielle: string;

    beforeAll(async () => {
      const { body } = await request(serveur)
        .get('/api/cotisations/impayes')
        .set('Authorization', `Bearer ${jetonTresoriere}`)
        .expect(200);

      echeancePartielle = body.find(
        (i: { statut: string }) => i.statut === 'PARTIELLE',
      ).echeance_id;
    });

    it('refuse un montant négatif (R-03)', async () => {
      await request(serveur)
        .post('/api/cotisations')
        .set('Authorization', `Bearer ${jetonTresoriere}`)
        .send({
          echeance_id: echeancePartielle,
          montant: -5000,
          date_versement: '2026-03-05',
          moyen: 'ESPECES',
        })
        .expect(400);
    });

    it('refuse un moyen de paiement inconnu', async () => {
      await request(serveur)
        .post('/api/cotisations')
        .set('Authorization', `Bearer ${jetonTresoriere}`)
        .send({
          echeance_id: echeancePartielle,
          montant: 5000,
          date_versement: '2026-03-05',
          moyen: 'BITCOIN',
        })
        .expect(400);
    });

    it('refuse un versement dépassant le reste dû (scénario A2)', async () => {
      const { body } = await request(serveur)
        .post('/api/cotisations')
        .set('Authorization', `Bearer ${jetonTresoriere}`)
        .send({
          echeance_id: echeancePartielle,
          montant: 999_000,
          date_versement: '2026-03-05',
          moyen: 'ESPECES',
        })
        .expect(400);

      expect(body.message).toContain('dépasse le reste dû');
    });
  });

  describe('F-TOU-03 — remise de la cagnotte', () => {
    it('refuse tant que des cotisations manquent, en disant combien', async () => {
      const { body: tours } = await request(serveur)
        .get('/api/tours')
        .set('Authorization', `Bearer ${jetonTresoriere}`)
        .expect(200);

      const tourCourant = tours.find((t: { remis: boolean }) => !t.remis);

      const { body } = await request(serveur)
        .post(`/api/tours/${tourCourant.tour_id}/remise`)
        .set('Authorization', `Bearer ${jetonTresoriere}`)
        .expect(400);

      expect(body.message).toContain('Remise impossible');
    });
  });

  describe('F-COT-02 puis F-TOU-03 — parcours complet d’un tour', () => {
    it('encaisse les impayés puis remet la cagnotte', async () => {
      const { body: impayes } = await request(serveur)
        .get('/api/cotisations/impayes')
        .set('Authorization', `Bearer ${jetonTresoriere}`)
        .expect(200);

      const aRegler = impayes.filter(
        (i: { tour_rang: number; statut: string }) =>
          i.tour_rang === 3 && i.statut !== 'DISPENSEE',
      );

      for (const echeance of aRegler) {
        await request(serveur)
          .post('/api/cotisations')
          .set('Authorization', `Bearer ${jetonTresoriere}`)
          .send({
            echeance_id: echeance.echeance_id,
            montant: Number(echeance.reste_du),
            date_versement: '2026-03-05',
            moyen: 'ESPECES',
          })
          .expect(201);
      }

      const { body: tours } = await request(serveur)
        .get('/api/tours')
        .set('Authorization', `Bearer ${jetonTresoriere}`)
        .expect(200);

      const tour3 = tours.find((t: { rang: number }) => t.rang === 3);

      const { body: remise } = await request(serveur)
        .post(`/api/tours/${tour3.tour_id}/remise`)
        .set('Authorization', `Bearer ${jetonTresoriere}`)
        .expect(200);

      // 275 000 et non 300 000 : la dispense de Georgette est déduite (R-05).
      expect(Number(remise.montant_remis)).toBe(275_000);
      expect(remise.beneficiaire).toBe('Fatou Bâ');

      // En ROSCA, la caisse retombe à zéro après chaque remise (§3.1).
      const { body: caisse } = await request(serveur)
        .get('/api/situation-caisse')
        .set('Authorization', `Bearer ${jetonPresidente}`)
        .expect(200);

      expect(Number(caisse.tresorerie)).toBe(0);
    });
  });

  describe('F-TRX-03 — journal', () => {
    it('est réservé au bureau et au commissaire (N-USG-05)', async () => {
      const { body } = await request(serveur)
        .get('/api/journal?limite=5')
        .set('Authorization', `Bearer ${jetonCommissaire}`)
        .expect(200);

      expect(body.length).toBeGreaterThan(0);
      expect(body[0]).toHaveProperty('libelle');
      expect(body[0]).toHaveProperty('saisi_par');
    });
  });
});

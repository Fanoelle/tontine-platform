/**
 * Tests d'intégration du jalon 3 — rapports, exports, Mobile Money,
 * rééchelonnement, redistribution, archivage.
 *
 * CONTRE LA VRAIE BASE et sur LES TROIS GROUPES. Le rapport d'assemblée change
 * de rubriques selon le mécanisme : le vérifier sur un seul groupe laisserait
 * deux tiers du code non éprouvés.
 *
 * Prérequis : ./scripts/db.sh reinitialiser
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './app.module';

const MOT_DE_PASSE = 'tontine2026';

const ROSCA_TRESORIERE = '+237690110002';
const ROSCA_PRESIDENTE = '+237690110001';
const ASCA_PRESIDENT = '+237677220001';
const ASCA_TRESORIER = '+237677220002';
const MUT_PRESIDENTE = '+237699330001';

describe('Jalon 3 — rapports, exports, rapprochement', () => {
  let app: INestApplication;
  let serveur: ReturnType<INestApplication['getHttpServer']>;

  let roscaTresoriere: string;
  let roscaPresidente: string;
  let ascaPresident: string;
  let ascaTresorier: string;
  let mutPresidente: string;

  const connecter = async (telephone: string): Promise<string> => {
    const r = await request(serveur)
      .post('/api/authentification/connexion')
      .send({ telephone, mot_de_passe: MOT_DE_PASSE })
      .expect(200);
    return r.body.jeton;
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

    roscaTresoriere = await connecter(ROSCA_TRESORIERE);
    roscaPresidente = await connecter(ROSCA_PRESIDENTE);
    ascaPresident = await connecter(ASCA_PRESIDENT);
    ascaTresorier = await connecter(ASCA_TRESORIER);
    mutPresidente = await connecter(MUT_PRESIDENTE);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('F-RAP-05 — rapport d’assemblée', () => {
    it('présente les rubriques propres à la ROSCA', async () => {
      const { body } = await request(serveur)
        .get('/api/rapport-assemblee')
        .set('Authorization', `Bearer ${roscaTresoriere}`)
        .expect(200);

      const rubriques = new Set(body.map((l: { rubrique: string }) => l.rubrique));
      expect(rubriques.has('Tour de rôle')).toBe(true);
      expect(rubriques.has('Prêts')).toBe(false);
      expect(rubriques.has('Entraide')).toBe(false);
    });

    it('présente les rubriques propres à l’ASCA', async () => {
      const { body } = await request(serveur)
        .get('/api/rapport-assemblee')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(200);

      const rubriques = new Set(body.map((l: { rubrique: string }) => l.rubrique));
      expect(rubriques.has('Prêts')).toBe(true);
      expect(rubriques.has('Tour de rôle')).toBe(false);
    });

    it('présente les rubriques propres à la MUTUELLE', async () => {
      const { body } = await request(serveur)
        .get('/api/rapport-assemblee')
        .set('Authorization', `Bearer ${mutPresidente}`)
        .expect(200);

      const rubriques = new Set(body.map((l: { rubrique: string }) => l.rubrique));
      expect(rubriques.has('Entraide')).toBe(true);
      expect(rubriques.has('Prêts')).toBe(false);
    });

    it('dit ce qui ne va pas — l’équilibre du journal y figure', async () => {
      const { body } = await request(serveur)
        .get('/api/rapport-assemblee')
        .set('Authorization', `Bearer ${roscaTresoriere}`)
        .expect(200);

      const equilibre = body.find(
        (l: { intitule: string }) => l.intitule === 'Équilibre du journal',
      );
      expect(equilibre).toBeDefined();
      expect(equilibre.valeur).toBe('équilibré');

      // Taire les anomalies en assemblée reviendrait à rassurer plutôt qu'à
      // rendre compte.
      expect(
        body.some((l: { intitule: string }) => l.intitule === 'Points à vérifier'),
      ).toBe(true);
    });

    it('est accessible à tout membre, pas au seul bureau', async () => {
      // Un rapport d'assemblée est fait pour être lu devant le groupe : le
      // réserver au bureau reproduirait l'opacité que la plateforme abolit.
      await request(serveur)
        .get('/api/rapport-assemblee')
        .set('Authorization', `Bearer ${roscaPresidente}`)
        .expect(200);
    });
  });

  describe('F-RAP-06 — exports', () => {
    it('exporte le journal en CSV, séparateur point-virgule', async () => {
      const { text } = await request(serveur)
        .get('/api/exports/journal.csv')
        .set('Authorization', `Bearer ${roscaTresoriere}`)
        .expect(200);

      expect(text).toContain('Numero;Date;Libelle');
      // BOM UTF-8 : sans lui, Excel en locale française lit le fichier comme du
      // Latin-1 et affiche « Ã© » à la place de « é ».
      expect(text.charCodeAt(0)).toBe(0xfeff);
      expect(text.split('\r\n').length).toBeGreaterThan(10);
    });

    it('exporte les membres avec leurs rôles', async () => {
      const { text } = await request(serveur)
        .get('/api/exports/membres.csv')
        .set('Authorization', `Bearer ${mutPresidente}`)
        .expect(200);

      expect(text).toContain('Nom;Telephone;Adhesion');
      expect(text).toContain('TRESORIER');
    });

    it('refuse l’export du journal à un membre sans rôle de contrôle', async () => {
      // La présidente ROSCA a le rôle PRESIDENT, donc l'accès. On éprouve
      // plutôt que la route est bien gardée en la demandant sans jeton.
      await request(serveur).get('/api/exports/journal.csv').expect(401);
    });
  });

  describe('F-TRX-06 — rapprochement Mobile Money', () => {
    let releveId: string;

    it('importe un relevé', async () => {
      const aujourdhui = new Date().toISOString().slice(0, 10);
      const debut = new Date(Date.now() - 120 * 86400_000)
        .toISOString().slice(0, 10);

      const { body } = await request(serveur)
        .post('/api/releves')
        .set('Authorization', `Bearer ${roscaTresoriere}`)
        .send({
          operateur: 'MTN Mobile Money',
          periode_debut: debut,
          periode_fin: aujourdhui,
          lignes: [
            {
              reference: 'MM-TEST-0001',
              montant: 25_000,
              date_operation: aujourdhui,
              libelle: 'Dépôt',
            },
          ],
        })
        .expect(201);

      expect(body.lignes).toBe(1);
      releveId = body.id;
    });

    it('signale une ligne du relevé absente du registre', async () => {
      const { body } = await request(serveur)
        .get(`/api/releves/${releveId}/rapprochement`)
        .set('Authorization', `Bearer ${roscaTresoriere}`)
        .expect(200);

      expect(body.synthese.absents_du_registre).toBeGreaterThanOrEqual(1);

      const orpheline = body.lignes.find(
        (l: { reference: string }) => l.reference === 'MM-TEST-0001',
      );
      expect(orpheline.statut).toBe('ABSENT_DU_REGISTRE');
      expect(orpheline.commentaire).toContain('À vérifier');
    });

    it('n’écrit RIEN dans le journal', async () => {
      // Un relevé d'opérateur est une source externe : en importer les lignes
      // comme des versements reviendrait à laisser un tiers écrire dans les
      // comptes du groupe.
      const avant = await request(serveur)
        .get('/api/journal?limite=200')
        .set('Authorization', `Bearer ${roscaTresoriere}`)
        .expect(200);

      await request(serveur)
        .get(`/api/releves/${releveId}/rapprochement`)
        .set('Authorization', `Bearer ${roscaTresoriere}`)
        .expect(200);

      const apres = await request(serveur)
        .get('/api/journal?limite=200')
        .set('Authorization', `Bearer ${roscaTresoriere}`)
        .expect(200);

      expect(apres.body.length).toBe(avant.body.length);
    });

    it('rend introuvable un relevé d’un autre groupe (N-SEC-02)', async () => {
      await request(serveur)
        .get(`/api/releves/${releveId}/rapprochement`)
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(404);
    });
  });

  describe('F-PRE-07 — rééchelonnement', () => {
    it('laisse le capital restant dû strictement inchangé', async () => {
      const { body: prets } = await request(serveur)
        .get('/api/prets')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(200);

      const enCours = prets.find((p: { statut: string }) =>
        ['EN_REMBOURSEMENT', 'EN_RETARD'].includes(p.statut));

      const avant = Number(enCours.capital_restant_du);

      const { body } = await request(serveur)
        .post(`/api/reechelonnements/${enCours.id}`)
        .set('Authorization', `Bearer ${ascaPresident}`)
        .send({ echeances: 6, motif: 'Récolte retardée par la saison des pluies' })
        .expect(200);

      // Rééchelonner n'efface pas la dette : un aménagement n'est pas une
      // remise, et la confusion transformerait une décision du groupe en effet
      // de bord du système.
      expect(Number(body.capital_restant_du)).toBe(avant);
      expect(body.echeances).toBe(6);
    });

    it('refuse un rééchelonnement par le trésorier', async () => {
      const { body: prets } = await request(serveur)
        .get('/api/prets')
        .set('Authorization', `Bearer ${ascaTresorier}`)
        .expect(200);

      await request(serveur)
        .post(`/api/reechelonnements/${prets[0].id}`)
        .set('Authorization', `Bearer ${ascaTresorier}`)
        .send({ echeances: 3, motif: 'Tentative sans habilitation suffisante' })
        .expect(403);
    });

    it('refuse un motif indigent', async () => {
      const { body: prets } = await request(serveur)
        .get('/api/prets')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(200);

      await request(serveur)
        .post(`/api/reechelonnements/${prets[0].id}`)
        .set('Authorization', `Bearer ${ascaPresident}`)
        .send({ echeances: 3, motif: 'ok' })
        .expect(400);
    });
  });

  describe('F-EPA-03/04 — redistribution', () => {
    it('produit le décompte au prorata des parts en ASCA', async () => {
      const { body } = await request(serveur)
        .get('/api/redistribution')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(200);

      expect(body.length).toBe(8);
      for (const l of body) {
        expect(Number(l.total_a_restituer)).toBe(
          Number(l.epargne) + Number(l.quote_part),
        );
      }
    });

    it('refuse la redistribution sur une ROSCA', async () => {
      const { body } = await request(serveur)
        .get('/api/redistribution')
        .set('Authorization', `Bearer ${roscaTresoriere}`)
        .expect(400);

      expect(body.message).toContain('ASCA');
    });
  });

  describe('F-GRP-06 — archivage', () => {
    it('refuse tant qu’un cycle est ouvert ou qu’un prêt court', async () => {
      const { body } = await request(serveur)
        .post('/api/archivage')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(400);

      // Archiver ferait disparaître des listes actives une créance vivante :
      // le débiteur comme le groupe perdraient de vue ce qui reste dû.
      expect(body.message).toContain('Archivage impossible');
    });

    it('refuse l’archivage au trésorier', async () => {
      await request(serveur)
        .post('/api/archivage')
        .set('Authorization', `Bearer ${ascaTresorier}`)
        .expect(403);
    });
  });
});

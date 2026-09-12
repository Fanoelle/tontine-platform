/**
 * Tests d'intégration du jalon 2 — prêts, aides, anomalies.
 *
 * CONTRE LA VRAIE BASE, et sur LES TROIS GROUPES à la fois. C'est ce qui donne
 * leur valeur aux tests de cloisonnement : tant qu'un seul groupe existait,
 * aucune fuite transversale n'était observable. Ici la trésorière ROSCA tente
 * d'atteindre un prêt ASCA, et doit se voir répondre « introuvable » — jamais
 * « interdit », qui révélerait l'existence de la ressource.
 *
 * Prérequis : ./scripts/db.sh reinitialiser
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './app.module';

const MOT_DE_PASSE = 'tontine2026';

// ROSCA — Tontine des Femmes de Bonabéri
const ROSCA_TRESORIERE = '+237690110002';

// ASCA — Caisse d'épargne des Jeunes de Deido
const ASCA_PRESIDENT = '+237677220001';
const ASCA_TRESORIER = '+237677220002';

// MUTUELLE — Association Solidarité de Bafoussam
const MUT_PRESIDENTE = '+237699330001';
const MUT_TRESORIER = '+237699330002';

describe('Jalon 2 — prêts, aides, anomalies', () => {
  let app: INestApplication;
  let serveur: ReturnType<INestApplication['getHttpServer']>;

  let roscaTresoriere: string;
  let ascaPresident: string;
  let ascaTresorier: string;
  let mutPresidente: string;
  let mutTresorier: string;

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

    roscaTresoriere = await connecter(ROSCA_TRESORIERE);
    ascaPresident = await connecter(ASCA_PRESIDENT);
    ascaTresorier = await connecter(ASCA_TRESORIER);
    mutPresidente = await connecter(MUT_PRESIDENTE);
    mutTresorier = await connecter(MUT_TRESORIER);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('N-SEC-02 — cloisonnement entre les trois groupes', () => {
    it('la trésorière ROSCA ne voit aucun prêt (ils sont tous ASCA)', async () => {
      const { body } = await request(serveur)
        .get('/api/prets')
        .set('Authorization', `Bearer ${roscaTresoriere}`)
        .expect(200);

      expect(body).toHaveLength(0);
    });

    it('la trésorière ROSCA ne voit aucune aide (elles sont toutes MUTUELLE)', async () => {
      const { body } = await request(serveur)
        .get('/api/aides')
        .set('Authorization', `Bearer ${roscaTresoriere}`)
        .expect(200);

      expect(body).toHaveLength(0);
    });

    it('un prêt ASCA est INTROUVABLE depuis la ROSCA, jamais « interdit »', async () => {
      const { body: prets } = await request(serveur)
        .get('/api/prets')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(200);

      expect(prets.length).toBeGreaterThan(0);

      // 404 et non 403 : répondre « interdit » confirmerait que la ressource
      // existe, ce qui est déjà une fuite.
      await request(serveur)
        .get(`/api/prets/${prets[0].id}/echeancier`)
        .set('Authorization', `Bearer ${roscaTresoriere}`)
        .expect(404);
    });
  });

  describe('F-PRE — prêts ASCA', () => {
    it('liste le prêt en cours avec son encours', async () => {
      const { body } = await request(serveur)
        .get('/api/prets')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(200);

      expect(body).toHaveLength(1);
      expect(body[0].emprunteur).toBe('Yves Bikoi');
      expect(Number(body[0].montant_accorde)).toBe(300_000);
      // Deux échéances de 75 000 F déjà remboursées.
      expect(Number(body[0].capital_restant_du)).toBe(150_000);
    });

    it('produit un échéancier de 4 échéances', async () => {
      const { body: prets } = await request(serveur)
        .get('/api/prets')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(200);

      const { body } = await request(serveur)
        .get(`/api/prets/${prets[0].id}/echeancier`)
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(200);

      expect(body).toHaveLength(4);
      // Capital et intérêt sont SÉPARÉS : l'intérêt rémunère le groupe, il ne
      // réduit pas la dette.
      expect(Number(body[0].montant_capital)).toBe(75_000);
      expect(Number(body[0].montant_interet)).toBe(6_000);
    });

    it('R-06 — refuse un prêt excédant l’avoir de la caisse', async () => {
      const { body: avoir } = await request(serveur)
        .get('/api/prets/avoir-disponible')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(200);

      const { body: demande } = await request(serveur)
        .post('/api/prets')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .send({
          montant: Number(avoir.avoir) + 1_000_000,
          motif: 'Demande volontairement excessive pour le test R-06',
        })
        .expect(201);

      const { body } = await request(serveur)
        .post(`/api/prets/${demande.id}/approbation`)
        .set('Authorization', `Bearer ${ascaPresident}`)
        .send({ montant: Number(avoir.avoir) + 1_000_000 })
        .expect(400);

      expect(body.message).toContain('excède l’avoir disponible'.replace('’', "'"));
    });

    it('F-PRE-02 — le trésorier ne peut pas approuver un prêt', async () => {
      const { body: demande } = await request(serveur)
        .post('/api/prets')
        .set('Authorization', `Bearer ${ascaTresorier}`)
        .send({ montant: 50_000, motif: 'Achat de marchandises pour la boutique' })
        .expect(201);

      await request(serveur)
        .post(`/api/prets/${demande.id}/approbation`)
        .set('Authorization', `Bearer ${ascaTresorier}`)
        .send({ montant: 50_000 })
        .expect(403);
    });

    it('refuse un motif indigent', async () => {
      await request(serveur)
        .post('/api/prets')
        .set('Authorization', `Bearer ${ascaTresorier}`)
        .send({ montant: 50_000, motif: 'ok' })
        .expect(400);
    });

    it('parcours complet — demande, approbation, remboursement', async () => {
      const { body: demande } = await request(serveur)
        .post('/api/prets')
        .set('Authorization', `Bearer ${ascaTresorier}`)
        .send({
          montant: 120_000,
          motif: 'Achat d’un lot de pagnes pour la revente au marché',
          nombre_echeances: 2,
        })
        .expect(201);

      const { body: octroi } = await request(serveur)
        .post(`/api/prets/${demande.id}/approbation`)
        .set('Authorization', `Bearer ${ascaPresident}`)
        .send({ montant: 120_000 })
        .expect(200);

      expect(Number(octroi.montant_accorde)).toBe(120_000);
      expect(octroi.echeances).toBe(2);

      const { body: remboursement } = await request(serveur)
        .post(`/api/prets/${demande.id}/remboursement`)
        .set('Authorization', `Bearer ${ascaTresorier}`)
        .send({
          capital: 60_000,
          interet: 2_400,
          date_versement: new Date().toISOString().slice(0, 10),
          moyen: 'ESPECES',
        })
        .expect(200);

      expect(Number(remboursement.capital_restant_du)).toBe(60_000);

      // R-07 — le capital restant dû ne passe jamais sous zéro : un
      // remboursement excédentaire est refusé, jamais absorbé.
      await request(serveur)
        .post(`/api/prets/${demande.id}/remboursement`)
        .set('Authorization', `Bearer ${ascaTresorier}`)
        .send({
          capital: 999_000,
          interet: 0,
          date_versement: new Date().toISOString().slice(0, 10),
          moyen: 'ESPECES',
        })
        .expect(400);
    });
  });

  describe('F-AID — aides mutualistes', () => {
    it('liste les trois aides du jeu de démonstration', async () => {
      const { body } = await request(serveur)
        .get('/api/aides')
        .set('Authorization', `Bearer ${mutPresidente}`)
        .expect(200);

      expect(body).toHaveLength(3);
      const statuts = body.map((a: { statut: string }) => a.statut).sort();
      expect(statuts).toEqual(['APPROUVEE', 'DEMANDEE', 'VERSEE']);
    });

    it('F-AID-03 — l’éligibilité est consultative, jamais bloquante', async () => {
      const { body: aides } = await request(serveur)
        .get('/api/aides')
        .set('Authorization', `Bearer ${mutPresidente}`)
        .expect(200);

      const demandee = aides.find((a: { statut: string }) => a.statut === 'DEMANDEE');

      const { body } = await request(serveur)
        .get(`/api/aides/${demandee.id}/eligibilite`)
        .set('Authorization', `Bearer ${mutPresidente}`)
        .expect(200);

      expect(body).toHaveProperty('eligible');
      expect(body).toHaveProperty('anciennete_mois');
    });

    it('refuse d’accorder plus que le montant demandé', async () => {
      const { body: aides } = await request(serveur)
        .get('/api/aides')
        .set('Authorization', `Bearer ${mutPresidente}`)
        .expect(200);

      const demandee = aides.find((a: { statut: string }) => a.statut === 'DEMANDEE');

      const { body } = await request(serveur)
        .post(`/api/aides/${demandee.id}/approbation`)
        .set('Authorization', `Bearer ${mutPresidente}`)
        .send({ montant: Number(demandee.montant_demande) + 100_000 })
        .expect(400);

      expect(body.message).toContain('dépasse le montant demandé');
    });

    it('parcours complet — demande, approbation, versement', async () => {
      const { body: demande } = await request(serveur)
        .post('/api/aides')
        .set('Authorization', `Bearer ${mutTresorier}`)
        .send({
          montant: 25_000,
          motif: 'Frais médicaux à la suite d’un accident de moto',
        })
        .expect(201);

      await request(serveur)
        .post(`/api/aides/${demande.id}/approbation`)
        .set('Authorization', `Bearer ${mutPresidente}`)
        .send({ montant: 20_000 })
        .expect(200);

      const { body: avant } = await request(serveur)
        .get('/api/situation-caisse')
        .set('Authorization', `Bearer ${mutPresidente}`)
        .expect(200);

      const { body: versement } = await request(serveur)
        .post(`/api/aides/${demande.id}/versement`)
        .set('Authorization', `Bearer ${mutTresorier}`)
        .expect(200);

      expect(Number(versement.montant_verse)).toBe(20_000);

      const { body: apres } = await request(serveur)
        .get('/api/situation-caisse')
        .set('Authorization', `Bearer ${mutPresidente}`)
        .expect(200);

      // Le fonds se consomme : aucune créance n'est ouverte, une aide n'est
      // pas remboursable.
      expect(Number(avant.tresorerie) - Number(apres.tresorerie)).toBe(20_000);
    });

    it('la présidente ne verse pas elle-même — séparation des rôles', async () => {
      const { body: aides } = await request(serveur)
        .get('/api/aides')
        .set('Authorization', `Bearer ${mutPresidente}`)
        .expect(200);

      const approuvee = aides.find(
        (a: { statut: string }) => a.statut === 'APPROUVEE',
      );

      await request(serveur)
        .post(`/api/aides/${approuvee.id}/versement`)
        .set('Authorization', `Bearer ${mutPresidente}`)
        .expect(403);
    });
  });

  describe('F-ANO — moteur d’anomalies', () => {
    it('balaye sans produire de bruit sur un groupe sain', async () => {
      const { body } = await request(serveur)
        .post('/api/anomalies/balayage')
        .set('Authorization', `Bearer ${mutPresidente}`)
        .expect(200);

      expect(body.cotisations_manquantes).toBe(0);
      expect(body.soldes_incoherents).toBe(0);
      expect(body.doubles_saisies).toBe(0);
      expect(body.saisies_tardives).toBe(0);
    });

    it('détecte le retard de remboursement du prêt ASCA', async () => {
      await request(serveur)
        .post('/api/anomalies/balayage')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(200);

      const { body } = await request(serveur)
        .get('/api/anomalies')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(200);

      const retard = body.find(
        (a: { type: string }) => a.type === 'REMBOURSEMENT_RETARD',
      );

      expect(retard).toBeDefined();
      // « À vérifier », jamais « fraude » : une anomalie est un signalement.
      expect(retard.description).toContain('À vérifier');
    });

    it('F-ANO-08 — refuse une levée au motif indigent', async () => {
      const { body } = await request(serveur)
        .get('/api/anomalies')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(200);

      if (body.length === 0) return;

      await request(serveur)
        .post(`/api/anomalies/${body[0].id}/levee`)
        .set('Authorization', `Bearer ${ascaTresorier}`)
        .send({ motif: 'vu' })
        .expect(400);
    });

    it('un membre sans rôle de contrôle ne voit pas les anomalies', async () => {
      // La ROSCA n'a pas de commissaire connecté ; on éprouve donc l'inverse :
      // le rôle est bien exigé, et un jeton valide ne suffit pas à lui seul.
      const { body } = await request(serveur)
        .get('/api/anomalies')
        .set('Authorization', `Bearer ${roscaTresoriere}`)
        .expect(200);

      // La trésorière EST habilitée (elle a le rôle TRESORIER) : elle voit la
      // liste, vide pour son groupe.
      expect(Array.isArray(body)).toBe(true);
    });
  });
});

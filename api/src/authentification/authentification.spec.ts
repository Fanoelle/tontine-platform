/**
 * Tests d'intégration de la couche d'authentification.
 *
 * CONTRE UNE VRAIE BASE, jamais contre des doublures (décision 0001). Les
 * invariants vivent dans le schéma : une doublure testerait le code TypeScript
 * en ignorant précisément ce qui peut casser. Un test qui ne tente pas de
 * franchir une garde ne prouve rien.
 *
 * Prérequis : ./scripts/db.sh demarrer (migrations + jeux de données).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';

const TELEPHONE_TRESORIERE = '+237690110002';
const TELEPHONE_PRESIDENTE = '+237690110001';
const MOT_DE_PASSE = 'tontine2026';

describe('Authentification et gardes', () => {
  let application: INestApplication;
  let serveur: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    // Le secret doit exister avant la construction du module : JwtModule le lit
    // par getOrThrow, qui fait échouer le démarrage s'il manque.
    process.env.JWT_SECRET ??= 'secret-de-test';

    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    application = module.createNestApplication();
    application.setGlobalPrefix('api');
    application.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await application.init();
    serveur = application.getHttpServer();
  });

  afterAll(async () => {
    await application?.close();
  });

  describe('N-SEC-04 — routes protégées par défaut', () => {
    it('refuse une route sans jeton', async () => {
      await request(serveur).get('/api/authentification/session').expect(401);
    });

    it('refuse un jeton fantaisiste', async () => {
      await request(serveur)
        .get('/api/authentification/session')
        .set('Authorization', 'Bearer pas-un-jeton')
        .expect(401);
    });

    it('refuse un schéma autre que Bearer', async () => {
      await request(serveur)
        .get('/api/authentification/session')
        .set('Authorization', 'Basic dXNlcjpwYXNz')
        .expect(401);
    });
  });

  describe('N-SEC-01 — connexion', () => {
    it('ouvre une session avec des identifiants valides', async () => {
      const reponse = await request(serveur)
        .post('/api/authentification/connexion')
        .send({ telephone: TELEPHONE_TRESORIERE, mot_de_passe: MOT_DE_PASSE })
        .expect(200);

      expect(reponse.body.jeton).toEqual(expect.any(String));
      expect(reponse.body.membre.roles).toContain('TRESORIER');
      expect(reponse.body.groupe.type).toBe('ROSCA');
    });

    it('refuse un mot de passe erroné', async () => {
      await request(serveur)
        .post('/api/authentification/connexion')
        .send({ telephone: TELEPHONE_TRESORIERE, mot_de_passe: 'mauvais-mot-de-passe' })
        .expect(401);
    });

    it("refuse un téléphone inconnu, sans révéler qu'il est inconnu", async () => {
      const reponse = await request(serveur)
        .post('/api/authentification/connexion')
        .send({ telephone: '+237600000000', mot_de_passe: MOT_DE_PASSE })
        .expect(401);

      // Message identique à celui d'un mot de passe erroné : distinguer les deux
      // permettrait d'énumérer les membres d'un groupe.
      expect(reponse.body.message).toBe('Téléphone ou mot de passe incorrect');
    });

    it('refuse un téléphone mal formé (miroir de la contrainte SQL R-10)', async () => {
      await request(serveur)
        .post('/api/authentification/connexion')
        .send({ telephone: '690110002', mot_de_passe: MOT_DE_PASSE })
        .expect(400);
    });

    it('rejette une propriété non déclarée', async () => {
      // whitelist + forbidNonWhitelisted : un client ne doit pas pouvoir
      // glisser un groupe_id en espérant qu'il soit lu un jour (N-SEC-03).
      await request(serveur)
        .post('/api/authentification/connexion')
        .send({
          telephone: TELEPHONE_TRESORIERE,
          mot_de_passe: MOT_DE_PASSE,
          groupe_id: '00000000-0000-0000-0000-000000000000',
        })
        .expect(400);
    });
  });

  describe('N-SEC-03 — le groupe vient du jeton', () => {
    it('expose le groupe dans la session, sans paramètre d’URL', async () => {
      const connexion = await request(serveur)
        .post('/api/authentification/connexion')
        .send({ telephone: TELEPHONE_PRESIDENTE, mot_de_passe: MOT_DE_PASSE })
        .expect(200);

      const session = await request(serveur)
        .get('/api/authentification/session')
        .set('Authorization', `Bearer ${connexion.body.jeton}`)
        .expect(200);

      expect(session.body.groupe_id).toBe(connexion.body.groupe.id);
      expect(session.body.roles).toContain('PRESIDENT');
    });
  });
});

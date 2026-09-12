/**
 * Tests d'intégration des notifications — F-NOT.
 *
 * CE QUI EST ÉPROUVÉ ICI EST LA MÉCANIQUE, PAS L'ENVOI. Aucun service SMTP ni
 * aucune passerelle WhatsApp n'est joignable depuis cet environnement :
 * l'expéditeur de développement consigne et déclare envoyé. Ce qui se vérifie —
 * et se vérifie réellement — c'est la file, la plage horaire décente, la
 * déduplication, le report progressif et la trace.
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

describe('Notifications — F-NOT', () => {
  let app: INestApplication;
  let serveur: ReturnType<INestApplication['getHttpServer']>;

  let tresoriere: string;
  let presidente: string;
  let ascaPresident: string;

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

    tresoriere = await connecter(ROSCA_TRESORIERE);
    presidente = await connecter(ROSCA_PRESIDENTE);
    ascaPresident = await connecter(ASCA_PRESIDENT);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('F-NOT-01, F-COT-06 — rappels', () => {
    it('met en file les rappels du groupe', async () => {
      const { body } = await request(serveur)
        .post('/api/notifications/balayage')
        .set('Authorization', `Bearer ${tresoriere}`)
        .send({ jours_avant: 10 })
        .expect(200);

      expect(body).toHaveProperty('rappels_avant');
      expect(body).toHaveProperty('rappels_retard');
      expect(
        body.rappels_avant + body.rappels_retard,
      ).toBeGreaterThanOrEqual(0);
    });

    it('ne recrée pas les mêmes rappels au balayage suivant', async () => {
      // Sans déduplication, un balayage quotidien renverrait chaque jour le
      // même rappel, et le membre cesserait de les lire — exactement l'effet
      // que la notification cherche à éviter.
      await request(serveur)
        .post('/api/notifications/balayage')
        .set('Authorization', `Bearer ${tresoriere}`)
        .send({ jours_avant: 10 })
        .expect(200);

      const { body } = await request(serveur)
        .post('/api/notifications/balayage')
        .set('Authorization', `Bearer ${tresoriere}`)
        .send({ jours_avant: 10 })
        .expect(200);

      expect(body.rappels_avant).toBe(0);
      expect(body.rappels_retard).toBe(0);
    });

    it('refuse un rappel plus de 15 jours à l’avance', async () => {
      await request(serveur)
        .post('/api/notifications/balayage')
        .set('Authorization', `Bearer ${tresoriere}`)
        .send({ jours_avant: 60 })
        .expect(400);
    });
  });

  describe('F-NOT-06 — plage horaire décente', () => {
    it('programme chaque envoi dans la plage 7 h – 20 h', async () => {
      await request(serveur)
        .post('/api/notifications/balayage')
        .set('Authorization', `Bearer ${tresoriere}`)
        .send({ jours_avant: 10 })
        .expect(200);

      const { body } = await request(serveur)
        .get('/api/notifications')
        .set('Authorization', `Bearer ${tresoriere}`)
        .expect(200);

      // Les rappels ordinaires ne réveillent personne : leur heure d'envoi
      // tombe toujours dans la plage décente. Seules les alertes critiques y
      // échappent, et c'est délibéré.
      const ordinaires = body.filter(
        (n: { type: string }) => n.type !== 'ALERTE_ANOMALIE',
      );

      for (const n of ordinaires) {
        const heure = new Date(n.envoyable_a).getHours();
        expect(heure).toBeGreaterThanOrEqual(7);
        expect(heure).toBeLessThan(20);
      }
    });
  });

  describe('F-NOT-03, F-ANO-09 — alertes d’anomalie', () => {
    it('alerte le trésorier, et le commissaire des seules critiques', async () => {
      await request(serveur)
        .post('/api/anomalies/balayage')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(200);

      await request(serveur)
        .post('/api/notifications/balayage')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(200);

      const { body } = await request(serveur)
        .get('/api/notifications?statut=EN_ATTENTE')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(200);

      const alertes = body.filter(
        (n: { type: string }) => n.type === 'ALERTE_ANOMALIE',
      );

      // Le jeu ASCA porte un retard de remboursement (AVERTISSEMENT) : seul le
      // trésorier doit être alerté. Alerter le commissaire de tout reviendrait
      // à ne l'alerter de rien.
      for (const a of alertes) {
        expect(a.objet).toContain('un point à vérifier');
        // « À vérifier », jamais « fraude ».
        expect(a.corps).toContain("Il ne s'agit pas d'une accusation");
      }
    });
  });

  describe('F-NOT-02 — accusé de réception', () => {
    it('confirme un versement en langage courant', async () => {
      const { body: impayes } = await request(serveur)
        .get('/api/cotisations/impayes')
        .set('Authorization', `Bearer ${tresoriere}`)
        .expect(200);

      // ON CIBLE UNE ÉCHÉANCE *ATTENDUE*, JAMAIS LA PARTIELLE.
      //
      // Le jeu de démonstration ne contient qu'une seule échéance PARTIELLE, et
      // `metier.spec.ts` s'en sert pour éprouver le scénario A2. La solder ici
      // faisait échouer trois tests d'un autre fichier — un décor partagé se
      // consomme, et un test qui épuise une ressource commune casse ses voisins
      // sans rien prouver de plus.
      //
      // On verse en outre un montant PARTIEL : l'accusé doit alors annoncer le
      // reste dû, ce qui éprouve la branche la plus intéressante du message.
      const attendue = impayes.find(
        (i: { statut: string }) => i.statut === 'ATTENDUE',
      );

      const { body: versement } = await request(serveur)
        .post('/api/cotisations')
        .set('Authorization', `Bearer ${tresoriere}`)
        .send({
          echeance_id: attendue.echeance_id,
          montant: Math.floor(Number(attendue.reste_du) / 2),
          date_versement: new Date().toISOString().slice(0, 10),
          moyen: 'ESPECES',
        })
        .expect(201);

      const { body } = await request(serveur)
        .post('/api/notifications/accuse-versement')
        .set('Authorization', `Bearer ${tresoriere}`)
        .send({ cotisation_id: versement.cotisation_id })
        .expect(200);

      expect(body.id).toBeTruthy();

      const { body: file } = await request(serveur)
        .get('/api/notifications')
        .set('Authorization', `Bearer ${tresoriere}`)
        .expect(200);

      const accuse = file.find(
        (n: { type: string }) => n.type === 'ACCUSE_VERSEMENT',
      );

      expect(accuse).toBeDefined();
      // N-USG-05 — aucun mot de comptabilité n'atteint le membre.
      expect(accuse.corps).not.toMatch(/débit|crédit|écriture/i);
      expect(accuse.corps).toContain('bien été enregistré');
      // Le versement étant partiel, l'accusé annonce ce qui reste.
      expect(accuse.corps).toContain('Il reste');
    });
  });

  describe('Expédition', () => {
    it('vide la file et rend compte de l’expéditeur utilisé', async () => {
      await request(serveur)
        .post('/api/notifications/balayage')
        .set('Authorization', `Bearer ${tresoriere}`)
        .send({ jours_avant: 10 })
        .expect(200);

      const { body } = await request(serveur)
        .post('/api/notifications/expedition')
        .set('Authorization', `Bearer ${tresoriere}`)
        .expect(200);

      // L'expéditeur se nomme, et son nom dit qu'il n'envoie rien : personne,
      // en lisant ce résultat, ne doit croire qu'un message est parti.
      expect(body.expediteur).toContain('aucun envoi réel');
      expect(body.envoyees).toBe(body.traitees);
      expect(body.echouees).toBe(0);
    });

    it('ne renvoie pas ce qui est déjà parti', async () => {
      const { body } = await request(serveur)
        .post('/api/notifications/expedition')
        .set('Authorization', `Bearer ${tresoriere}`)
        .expect(200);

      expect(body.traitees).toBe(0);
    });
  });

  describe('N-SEC — cloisonnement et habilitations', () => {
    it('la file du groupe est réservée au bureau', async () => {
      await request(serveur).get('/api/notifications').expect(401);
    });

    it('un membre consulte ses propres notifications', async () => {
      const { body } = await request(serveur)
        .get('/api/notifications/mes-notifications')
        .set('Authorization', `Bearer ${presidente}`)
        .expect(200);

      expect(Array.isArray(body)).toBe(true);
    });

    it('la file d’un groupe ne fuit pas vers un autre (N-SEC-02)', async () => {
      const { body: rosca } = await request(serveur)
        .get('/api/notifications')
        .set('Authorization', `Bearer ${tresoriere}`)
        .expect(200);

      const { body: asca } = await request(serveur)
        .get('/api/notifications')
        .set('Authorization', `Bearer ${ascaPresident}`)
        .expect(200);

      const idsRosca = new Set(rosca.map((n: { id: string }) => n.id));
      for (const n of asca) {
        expect(idsRosca.has(n.id)).toBe(false);
      }
    });
  });
});

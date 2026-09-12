/**
 * Reprise d'un cahier existant — analyse du CSV et import complet.
 *
 * DEUX NIVEAUX, DEUX PRÉOCCUPATIONS. L'analyseur est éprouvé seul, sur des
 * fichiers tels qu'un tableur les produit vraiment : point-virgule d'Excel
 * français, BOM de Windows, dates en JJ/MM/AAAA, montants avec espaces
 * insécables. L'import complet est éprouvé contre la base, et ce qu'on y
 * vérifie tient en une ligne : le journal reste équilibré (R-01).
 *
 * POURQUOI TANT DE CAS DE REFUS. Parce qu'un import est à peu près
 * irréversible du point de vue de l'utilisateur — le journal étant immuable,
 * revenir en arrière suppose de détruire le groupe. Chaque refus testé ici est
 * un cahier faux qui n'entrera pas dans la base.
 *
 * Prérequis : ./scripts/db.sh reinitialiser
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './app.module';
import { BaseService } from './base/base.service';
import {
  ErreurCahier,
  analyserCahier,
  decouperLigne,
} from './import/cahier.analyseur';

describe('Analyseur de cahier — formats réels', () => {
  it('lit un CSV à virgules', () => {
    const { lignes } = analyserCahier(
      'nom,telephone,rang,tour,date,montant,moyen\n'
        + 'Awa Diop,+237690110001,1,1,2025-01-06,15000,especes\n',
    );

    expect(lignes).toHaveLength(1);
    expect(lignes[0].membre_nom).toBe('Awa Diop');
    expect(lignes[0].membre_telephone).toBe('+237690110001');
    expect(lignes[0].rang_beneficiaire).toBe(1);
    expect(lignes[0].montant).toBe(15000);
    expect(lignes[0].moyen).toBe('ESPECES');
  });

  it('lit le point-virgule d\'Excel français', () => {
    // Excel en français sépare par point-virgule, la virgule étant le
    // séparateur décimal. C'est le format que produiront la plupart des
    // utilisateurs visés.
    const { lignes } = analyserCahier(
      'nom;telephone;rang;tour;date;montant\n'
        + 'Awa Diop;+237690110001;1;1;06/01/2025;15000\n',
    );

    expect(lignes).toHaveLength(1);
    expect(lignes[0].date_operation).toBe('2025-01-06');
  });

  it('survit au BOM des tableurs Windows', () => {
    // Sans retrait du BOM, le premier en-tête devient « ﻿nom » et la
    // colonne « nom » paraît absente — erreur incompréhensible pour qui
    // regarde son fichier et y voit bien une colonne « nom ».
    const { lignes } = analyserCahier(
      '﻿nom;telephone;montant;date\n'
        + 'Awa Diop;+237690110001;15000;06/01/2025\n',
    );

    expect(lignes[0].membre_nom).toBe('Awa Diop');
  });

  it('tolère accents, casse et espaces dans les en-têtes', () => {
    const { lignes } = analyserCahier(
      'Nom Complet;Téléphone;Montant Versé;Date\n'
        + 'Awa Diop;+237690110001;15000;06/01/2025\n',
    );

    expect(lignes[0].membre_nom).toBe('Awa Diop');
    expect(lignes[0].montant).toBe(15000);
  });

  it('découpe un nom contenant une virgule', () => {
    // « Diop, Awa » est une graphie courante ; un split(',') naïf la
    // transformerait en deux colonnes et décalerait toute la ligne.
    const champs = decouperLigne('"Diop, Awa",+237690110001,15000', ',');

    expect(champs).toEqual(['Diop, Awa', '+237690110001', '15000']);
  });

  it('lit un montant écrit avec des séparateurs de milliers', () => {
    const { lignes } = analyserCahier(
      'nom;telephone;montant;date\n'
        + 'Awa;+237690110001;15 000;06/01/2025\n'
        + 'Bea;+237690110002;15.000;06/01/2025\n',
    );

    expect(lignes[0].montant).toBe(15000);
    expect(lignes[1].montant).toBe(15000);
  });

  it('complète un numéro local avec l\'indicatif fourni', () => {
    const { lignes } = analyserCahier(
      'nom;telephone;montant;date\nAwa;690110001;15000;06/01/2025\n',
      { indicatifDefaut: '+237' },
    );

    expect(lignes[0].membre_telephone).toBe('+237690110001');
  });

  it('accepte la notation 00237 comme équivalente à +237', () => {
    const { lignes } = analyserCahier(
      'nom;telephone;montant;date\nAwa;00237690110001;15000;06/01/2025\n',
    );

    expect(lignes[0].membre_telephone).toBe('+237690110001');
  });

  it('reconnaît les graphies usuelles du mobile money', () => {
    const { lignes } = analyserCahier(
      'nom;telephone;montant;date;moyen\n'
        + 'A;+237690110001;15000;06/01/2025;MoMo\n'
        + 'B;+237690110002;15000;06/01/2025;Orange Money\n'
        + 'C;+237690110003;15000;06/01/2025;cash\n',
    );

    expect(lignes.map((l) => l.moyen)).toEqual([
      'MOBILE_MONEY',
      'MOBILE_MONEY',
      'ESPECES',
    ]);
  });

  it('ignore les lignes vides laissées par un tableur', () => {
    const { lignes } = analyserCahier(
      'nom;telephone;montant;date\n'
        + 'Awa;+237690110001;15000;06/01/2025\n'
        + '\n'
        + ';;;\n'
        + 'Bea;+237690110002;15000;06/01/2025\n',
    );

    expect(lignes).toHaveLength(2);
  });
});

describe('Analyseur de cahier — ce qu\'il refuse', () => {
  const refuse = (contenu: string, motif: RegExp) => {
    expect(() => analyserCahier(contenu)).toThrow(ErreurCahier);
    expect(() => analyserCahier(contenu)).toThrow(motif);
  };

  it('refuse un fichier sans colonne « nom »', () => {
    refuse('telephone;montant\n+237690110001;15000\n', /nom.*introuvable/i);
  });

  it('refuse un fichier sans colonne « telephone »', () => {
    // Le téléphone identifie le membre : sans lui, deux homonymes sont
    // indiscernables et l'import fusionnerait deux personnes.
    refuse('nom;montant\nAwa;15000\n', /telephone.*introuvable/i);
  });

  it('refuse une date illisible EN NOMMANT LA LIGNE', () => {
    // Le numéro de ligne est ce qui rend l'erreur actionnable : sans lui,
    // l'utilisateur relit trois cents lignes.
    refuse(
      'nom;telephone;montant;date\n'
        + 'Awa;+237690110001;15000;06/01/2025\n'
        + 'Bea;+237690110002;15000;le 7 janvier\n',
      /Ligne 3.*illisible/i,
    );
  });

  /**
   * LE CAS QUI A FAILLI PASSER. Une première version retirait virgules et
   * lettres sans distinction : « 150,00 F » devenait « 15000 ». Cent cinquante
   * francs importés comme quinze mille, silencieusement, dans un journal
   * immuable. La règle est trop subtile pour tenir sur un exemple — d'où le
   * tableau : ce qui distingue un séparateur de milliers d'un séparateur
   * décimal est le nombre de chiffres qui le suit.
   */
  it.each([
    ['15000', 15000],
    ['15 000', 15000],
    ['15.000', 15000],
    ["15'000", 15000],
    ['15000 F', 15000],
    ['15 000 FCFA', 15000],
    ['1 500 000', 1500000],
    ['1.500.000', 1500000],
  ])('lit « %s » comme %i', (brut, attendu) => {
    const { lignes } = analyserCahier(
      `nom;telephone;montant;date\nAwa;+237690110001;${brut};06/01/2025\n`,
    );
    expect(lignes[0].montant).toBe(attendu);
  });

  it.each([
    ['150,00 F'],
    ['150.00'],
    ['150,5'],
    ['15.000,50'],
    ['abc'],
    ['0'],
  ])('refuse « %s »', (brut) => {
    expect(() =>
      analyserCahier(
        `nom;telephone;montant;date\nAwa;+237690110001;${brut};06/01/2025\n`,
      ),
    ).toThrow(ErreurCahier);
  });

  it('refuse un versement sans date', () => {
    // Une écriture comptable sans date est inexploitable : elle ne peut ni
    // être rapprochée, ni apparaître dans une situation à une date donnée.
    refuse(
      'nom;telephone;montant;date\nAwa;+237690110001;15000;\n',
      /sans date/i,
    );
  });

  it('refuse un téléphone sans indicatif quand aucun défaut n\'est donné', () => {
    refuse(
      'nom;telephone;montant;date\nAwa;06 12 34 56 78;15000;06/01/2025\n',
      /Téléphone illisible/i,
    );
  });

  it('refuse un membre portant deux rangs différents', () => {
    // Un membre ne touche la cagnotte qu'une fois par cycle (R-04).
    refuse(
      'nom;telephone;rang;tour;montant;date\n'
        + 'Awa;+237690110001;1;1;15000;06/01/2025\n'
        + 'Awa;+237690110001;3;2;15000;06/02/2025\n',
      /deux rangs différents/i,
    );
  });

  it('refuse deux membres au même rang', () => {
    refuse(
      'nom;telephone;rang;montant;date\n'
        + 'Awa;+237690110001;1;15000;06/01/2025\n'
        + 'Bea;+237690110002;1;15000;06/01/2025\n',
      /partagent le rang/i,
    );
  });

  it('refuse un moyen de paiement inconnu plutôt que de deviner', () => {
    refuse(
      'nom;telephone;montant;date;moyen\n'
        + 'Awa;+237690110001;15000;06/01/2025;bitcoin\n',
      /Moyen de paiement inconnu/i,
    );
  });

  it('avertit — sans refuser — quand la colonne montant manque', () => {
    const { lignes, avertissements } = analyserCahier(
      'nom;telephone;rang\nAwa;+237690110001;1\nBea;+237690110002;2\n',
    );

    expect(lignes).toHaveLength(2);
    expect(avertissements.join(' ')).toMatch(/aucun versement/i);
  });
});

describe('Import complet — contre la base', () => {
  let app: INestApplication;
  let serveur: ReturnType<INestApplication['getHttpServer']>;
  let base: BaseService;
  let jeton: string;
  let groupeId: string;

  const CAHIER = [
    'nom;telephone;rang;tour;date;montant;moyen',
    'Nadia Kamga;+237691000001;1;1;06/01/2025;10000;especes',
    'Sylvie Fouda;+237691000002;2;1;06/01/2025;10000;especes',
    'Rose Manga;+237691000003;3;1;07/01/2025;10000;momo',
    'Nadia Kamga;+237691000001;1;2;06/02/2025;10000;especes',
    'Sylvie Fouda;+237691000002;2;2;06/02/2025;10000;especes',
    'Rose Manga;+237691000003;3;2;08/02/2025;10000;especes',
  ].join('\n');

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'secret-de-test';
    process.env.RAPPELS_AUTOMATIQUES = 'non';

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
    base = app.get(BaseService);

    // LE GROUPE D'UN PASSAGE PRÉCÉDENT EST ARCHIVÉ, PAS SUPPRIMÉ.
    //
    // Le journal comptable est immuable (R-02) : `tontine_app` n'a pas le
    // droit de supprimer une écriture, et un trigger le lui refuserait de
    // toute façon. Forcer la suppression depuis un test reviendrait à
    // démontrer que la garantie centrale de la plateforme se contourne.
    //
    // L'archivage suffit à ce dont ce test a besoin : le groupe est écarté du
    // balayage automatique, et un nouveau groupe est créé à chaque passage.
    // La suite reste ainsi rejouable sans réinitialiser la base.
    await base.requete(
      `UPDATE groupe SET archive = true
        WHERE nom LIKE 'Tontine reprise (test)%' AND NOT archive`,
    );

    // UN GROUPE NEUF, créé pour ce test : l'import est réservé aux groupes
    // sans cycle, et les groupes de démonstration en ont tous un. Le nom porte
    // un suffixe unique — deux groupes de même nom seraient indiscernables
    // dans la liste que voit un exploitant.
    const suffixe = Date.now().toString(36);
    const groupe = await base.requeteUne<{ id: string }>(
      `INSERT INTO groupe (nom, type, devise, date_creation)
       VALUES ($1, 'ROSCA', 'XAF', '2025-01-06')
       RETURNING id`,
      [`Tontine reprise (test) ${suffixe}`],
    );
    groupeId = groupe!.id;

    const membre = await base.requeteUne<{ id: string }>(
      `INSERT INTO membre (groupe_id, nom_complet, telephone, date_adhesion)
       VALUES ($1, 'Nadia Kamga', '+237691000001', '2025-01-06')
       RETURNING id`,
      [groupeId],
    );

    await base.requete(
      `INSERT INTO membre_role (membre_id, role, attribue_le)
       VALUES ($1, 'PRESIDENT', '2025-01-06')`,
      [membre!.id],
    );

    // LE TÉLÉPHONE DU COMPTE EST UNIQUE À L'ÉCHELLE DE LA BASE, contrairement
    // à celui du membre qui ne l'est que dans son groupe : un identifiant de
    // connexion ne peut pas désigner deux personnes. D'où le suffixe, qui rend
    // la suite rejouable sans réinitialisation.
    // Cinq chiffres tirés de l'horodatage : `suffixe` est en base 36 et porte
    // des lettres, que `membre_telephone_check` refuserait.
    const identifiant = `+2376910${String(Date.now() % 100000).padStart(5, '0')}`;

    await base.requete(
      `INSERT INTO utilisateur (membre_id, telephone, mot_de_passe_hash, actif)
       SELECT $1, $2, u.mot_de_passe_hash, true
         FROM utilisateur u LIMIT 1`,
      [membre!.id, identifiant],
    );

    const connexion = await request(serveur)
      .post('/api/authentification/connexion')
      .send({ telephone: identifiant, mot_de_passe: 'tontine2026' })
      .expect(200);

    jeton = connexion.body.jeton;
  });

  /**
   * LE GROUPE DE TEST N'EST PAS SUPPRIMÉ, ET C'EST UN CHOIX.
   *
   * Le journal comptable est immuable par construction (R-02) : les privilèges
   * de `tontine_app` sur `ecriture` et `ligne_ecriture` sont révoqués, et un
   * trigger refuse toute modification. C'est la garantie centrale de la
   * plateforme, et la contourner depuis une suite de tests reviendrait à
   * démontrer qu'elle se contourne.
   *
   * Un test qui a besoin d'une base vierge lance `./scripts/db.sh
   * reinitialiser` — c'est déjà le prérequis documenté en tête de chaque
   * fichier de test. Et depuis que ce groupe existe, une assertion de
   * `notifications.spec.ts` qui comptait « 3 groupes » en dur a été corrigée
   * pour compter contre la base : c'était elle qui était fragile.
   */
  afterAll(async () => {
    await app?.close();
  });

  it('prévisualise sans rien écrire', async () => {
    const { body } = await request(serveur)
      .post('/api/import/apercu')
      .set('Authorization', `Bearer ${jeton}`)
      .send({ contenu: CAHIER })
      .expect(200);

    expect(body.membres).toHaveLength(3);
    expect(body.membres[0].nom).toBe('Nadia Kamga');
    expect(body.nombre_versements).toBe(6);
    expect(body.montant_total).toBe(60000);
    expect(body.premiere_operation).toBe('2025-01-06');
    expect(body.tours_estimes).toBe(3);

    // RIEN N'A ÉTÉ ÉCRIT : c'est la propriété qui fait l'intérêt de l'aperçu.
    const cycles = await base.requete(
      `SELECT id FROM cycle WHERE groupe_id = $1`,
      [groupeId],
    );
    expect(cycles).toHaveLength(0);
  });

  it('importe le cahier et laisse le journal ÉQUILIBRÉ (R-01)', async () => {
    const { body } = await request(serveur)
      .post('/api/import')
      .set('Authorization', `Bearer ${jeton}`)
      .send({
        contenu: CAHIER,
        source: 'cahier-2025.csv',
        montant_cotisation: 10000,
        periodicite: 'MENSUELLE',
        date_debut: '2025-01-06',
      })
      .expect(201);

    expect(body.membres_crees).toBe(2); // Nadia existait déjà
    expect(body.tours_crees).toBe(3);
    expect(body.versements_crees).toBe(6);
    expect(body.montant_total).toBe(60000);

    // LA VÉRIFICATION QUI COMPTE. L'import rejoue les versements par
    // `enregistrer_versement()` plutôt que d'écrire dans le journal : si cette
    // discipline était rompue, l'écart ne serait pas nul.
    const ecart = await base.requeteUne<{ ecart: string }>(
      `SELECT coalesce(sum(CASE WHEN l.sens = 'DEBIT' THEN l.montant
                                ELSE -l.montant END), 0) AS ecart
         FROM ligne_ecriture l
         JOIN compte c ON c.id = l.compte_id
        WHERE c.groupe_id = $1`,
      [groupeId],
    );
    expect(Number(ecart!.ecart)).toBe(0);
  });

  it('respecte l\'ordre de passage déclaré dans le cahier', async () => {
    // L'information la plus chargée politiquement d'une tontine : qui touche
    // en premier a été négocié. La plateforme ne la redistribue pas.
    const tours = await base.requete<{ rang: number; nom_complet: string }>(
      `SELECT t.rang, m.nom_complet
         FROM tour t
         JOIN membre m ON m.id = t.beneficiaire_id
         JOIN cycle c ON c.id = t.cycle_id
        WHERE c.groupe_id = $1
        ORDER BY t.rang`,
      [groupeId],
    );

    expect(tours.map((t) => t.nom_complet)).toEqual([
      'Nadia Kamga',
      'Sylvie Fouda',
      'Rose Manga',
    ]);
  });

  it('consigne l\'import dans l\'historique (N-TRC-01)', async () => {
    const trace = await base.requeteUne<{ libelle: string; montant: string }>(
      `SELECT h.libelle, h.montant
         FROM historique h
         JOIN membre m ON m.id = h.auteur_id
        WHERE m.groupe_id = $1 AND h.type = 'CAHIER_IMPORTE'`,
      [groupeId],
    );

    expect(trace).toBeTruthy();
    expect(trace!.libelle).toContain('cahier-2025.csv');
    expect(Number(trace!.montant)).toBe(60000);
  });

  it('refuse le MÊME fichier une seconde fois', async () => {
    // Un double clic sur « Importer » doublerait tout l'historique, et le
    // déséquilibre ne se verrait qu'au rapprochement avec le cahier papier.
    const { body } = await request(serveur)
      .post('/api/import')
      .set('Authorization', `Bearer ${jeton}`)
      .send({
        contenu: CAHIER,
        source: 'cahier-2025.csv',
        montant_cotisation: 10000,
        periodicite: 'MENSUELLE',
        date_debut: '2025-01-06',
      })
      .expect(409);

    expect(body.message).toMatch(/déjà été importé/i);
  });

  it('refuse un import dans un groupe portant déjà un cycle', async () => {
    const { body } = await request(serveur)
      .post('/api/import')
      .set('Authorization', `Bearer ${jeton}`)
      .send({
        contenu: CAHIER.replace('Nadia', 'Nadja'), // empreinte différente
        source: 'autre.csv',
        montant_cotisation: 10000,
        periodicite: 'MENSUELLE',
        date_debut: '2025-01-06',
      })
      .expect(409);

    expect(body.message).toMatch(/déjà un cycle/i);
  });

  it('expose l\'historique des imports du groupe', async () => {
    const { body } = await request(serveur)
      .get('/api/import')
      .set('Authorization', `Bearer ${jeton}`)
      .expect(200);

    expect(body).toHaveLength(1);
    expect(body[0].source).toBe('cahier-2025.csv');
    expect(body[0].importe_par).toBe('Nadia Kamga');
  });

  it('rend 400 — et non 500 — sur un fichier mal formé', async () => {
    // Le fichier est en cause, pas le serveur. La distinction compte pour qui
    // lit les journaux d'exploitation, et pour qui reçoit l'erreur.
    const { body } = await request(serveur)
      .post('/api/import/apercu')
      .set('Authorization', `Bearer ${jeton}`)
      .send({ contenu: 'colonne_inconnue;autre\nvaleur;valeur\n' })
      .expect(400);

    expect(body.message).toMatch(/introuvable/i);
  });

  it('exige une authentification', async () => {
    await request(serveur)
      .post('/api/import/apercu')
      .send({ contenu: CAHIER })
      .expect(401);
  });
});

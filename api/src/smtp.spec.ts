/**
 * Épreuve du client SMTP contre un vrai serveur, sur une vraie prise TCP.
 *
 * CE QUE CES TESTS ÉTABLISSENT. Que le dialogue est conforme, que les cas
 * pénibles du protocole sont traités (réponses multi-lignes, point en début de
 * ligne, accents en en-tête), et surtout que les ÉCHECS produisent le bon
 * verdict : définitif quand l'adresse est invalide, temporaire quand le serveur
 * est saturé. Cette distinction commande le rejeu — la confondre ferait soit
 * abandonner un message récupérable, soit harceler un serveur pour rien.
 *
 * CE QU'ILS N'ÉTABLISSENT PAS, et il faut le dire : que Gmail ou l'hébergeur du
 * groupe acceptera le message. Aucun test local ne peut le prouver. Ce qui est
 * prouvé, c'est que le protocole est correctement parlé.
 */
import {
  ErreurSmtp,
  encoderEntete,
  envoyerCourriel,
  preparerCorps,
  type ConfigurationSmtp,
} from './notifications/smtp.client';
import {
  ServeurSmtpTest,
  decoderEntete,
} from './notifications/serveur-smtp-test';
import { ExpediteurSmtp, configurationDepuisEnvironnement }
  from './notifications/expediteur.smtp';

function configuration(
  port: number,
  supplement: Partial<ConfigurationSmtp> = {},
): ConfigurationSmtp {
  return {
    hote: '127.0.0.1',
    port,
    tlsImplicite: false,
    expediteur: 'tontine@exemple.test',
    nomClient: 'tontine.test',
    delaiMs: 5000,
    accepterCertificatInvalide: false,
    ...supplement,
  };
}

describe('Client SMTP — dialogue nominal', () => {
  let serveur: ServeurSmtpTest;
  let port: number;

  beforeEach(async () => {
    serveur = new ServeurSmtpTest();
    port = await serveur.demarrer();
  });

  afterEach(async () => {
    await serveur.arreter();
  });

  it('remet un message, expéditeur et destinataire conformes', async () => {
    await envoyerCourriel(configuration(port), {
      destinataire: 'awa@exemple.test',
      objet: 'Rappel',
      corps: 'Votre échéance arrive.',
    });

    expect(serveur.recus).toHaveLength(1);
    expect(serveur.recus[0].de).toBe('tontine@exemple.test');
    expect(serveur.recus[0].a).toEqual(['awa@exemple.test']);
    expect(serveur.recus[0].corps).toBe('Votre échéance arrive.');
  });

  it('lit une réponse multi-lignes sans se désynchroniser', async () => {
    // Le serveur de test répond à EHLO par quatre lignes dont trois de
    // continuation. Un client qui s'arrêterait à la première lirait ensuite
    // le « 250-PIPELINING » comme réponse au MAIL FROM — et le message
    // partirait quand même, avec une enveloppe fausse. Que le contenu arrive
    // intact prouve que le décalage n'a pas eu lieu.
    await envoyerCourriel(configuration(port), {
      destinataire: 'bineta@exemple.test',
      objet: 'Sujet',
      corps: 'Corps',
    });

    expect(serveur.recus[0].a).toEqual(['bineta@exemple.test']);
    expect(serveur.recus[0].corps).toBe('Corps');
  });

  it('encode un sujet accentué et le rend lisible à l\'arrivée', async () => {
    await envoyerCourriel(configuration(port), {
      destinataire: 'cheikh@exemple.test',
      objet: 'Rappel d\'échéance — 15 000 F à verser',
      corps: 'Bonjour',
    });

    const sujet = serveur.recus[0].entetes.subject;
    // Encodé sur le fil : un en-tête 8 bits brut est illégal (RFC 5322).
    expect(sujet).toMatch(/^=\?UTF-8\?B\?/);
    expect(decoderEntete(sujet)).toBe('Rappel d\'échéance — 15 000 F à verser');
  });

  it('préserve un corps accentué et multi-lignes', async () => {
    const corps = 'Chère Awa,\nVotre cotisation de 15 000 F est réglée.\nMerci.';

    await envoyerCourriel(configuration(port), {
      destinataire: 'awa@exemple.test',
      objet: 'Reçu',
      corps,
    });

    expect(serveur.recus[0].corps).toBe(corps);
  });

  it('double un point en début de ligne, sans tronquer le message', async () => {
    // Le cas qui casse en production et jamais en développement : une ligne
    // réduite à « . » termine le message si elle n'est pas protégée.
    const corps = 'Première ligne\n.\nDernière ligne';

    await envoyerCourriel(configuration(port), {
      destinataire: 'awa@exemple.test',
      objet: 'Point',
      corps,
    });

    expect(serveur.recus[0].corps).toBe(corps);
  });

  it('déclare les en-têtes attendus d\'un message conforme', async () => {
    await envoyerCourriel(configuration(port), {
      destinataire: 'awa@exemple.test',
      objet: 'Sujet',
      corps: 'Corps',
    });

    const entetes = serveur.recus[0].entetes;
    expect(entetes.from).toBe('tontine@exemple.test');
    expect(entetes.to).toBe('awa@exemple.test');
    expect(entetes['mime-version']).toBe('1.0');
    expect(entetes['content-type']).toContain('charset=UTF-8');
    expect(entetes['message-id']).toMatch(/^<.+@tontine\.test>$/);
    expect(entetes.date).toBeDefined();
  });
});

describe('Client SMTP — authentification', () => {
  it('s\'authentifie en PLAIN quand le serveur le propose', async () => {
    const serveur = new ServeurSmtpTest({
      exigerAuth: true,
      utilisateur: 'tresorier',
      motDePasse: 'secret-du-groupe',
    });
    const port = await serveur.demarrer();

    try {
      await envoyerCourriel(
        configuration(port, {
          utilisateur: 'tresorier',
          motDePasse: 'secret-du-groupe',
        }),
        { destinataire: 'awa@exemple.test', objet: 'S', corps: 'C' },
      );

      expect(serveur.recus[0].authentifie).toBe('tresorier');
    } finally {
      await serveur.arreter();
    }
  });

  it('se replie sur LOGIN quand PLAIN n\'est pas proposé', async () => {
    const serveur = new ServeurSmtpTest({
      exigerAuth: true,
      seulementAuthLogin: true,
      utilisateur: 'tresorier',
      motDePasse: 'secret-du-groupe',
    });
    const port = await serveur.demarrer();

    try {
      await envoyerCourriel(
        configuration(port, {
          utilisateur: 'tresorier',
          motDePasse: 'secret-du-groupe',
        }),
        { destinataire: 'awa@exemple.test', objet: 'S', corps: 'C' },
      );

      expect(serveur.recus[0].authentifie).toBe('tresorier');
    } finally {
      await serveur.arreter();
    }
  });

  it('échoue sur un mot de passe faux, SANS le divulguer', async () => {
    const serveur = new ServeurSmtpTest({
      exigerAuth: true,
      utilisateur: 'tresorier',
      motDePasse: 'le-bon',
    });
    const port = await serveur.demarrer();

    try {
      const echec = envoyerCourriel(
        configuration(port, {
          utilisateur: 'tresorier',
          motDePasse: 'le-mauvais',
        }),
        { destinataire: 'awa@exemple.test', objet: 'S', corps: 'C' },
      );

      await expect(echec).rejects.toThrow(ErreurSmtp);

      // Le motif d'erreur est consigné en base (`derniere_erreur`) et affiché
      // au trésorier. Un mot de passe qui s'y retrouverait serait lisible par
      // toute personne consultant la file.
      await echec.catch((erreur: Error) => {
        expect(erreur.message).not.toContain('le-mauvais');
        expect(erreur.message).toContain('masquées');
      });
    } finally {
      await serveur.arreter();
    }
  });

  it('refuse le message quand l\'authentification est exigée et absente', async () => {
    const serveur = new ServeurSmtpTest({
      exigerAuth: true,
      utilisateur: 'tresorier',
      motDePasse: 'secret',
    });
    const port = await serveur.demarrer();

    try {
      await expect(
        envoyerCourriel(configuration(port), {
          destinataire: 'awa@exemple.test',
          objet: 'S',
          corps: 'C',
        }),
      ).rejects.toThrow(ErreurSmtp);

      expect(serveur.recus).toHaveLength(0);
    } finally {
      await serveur.arreter();
    }
  });
});

describe('Client SMTP — pannes', () => {
  it('distingue un refus DÉFINITIF (5xx) — adresse invalide', async () => {
    const serveur = new ServeurSmtpTest();
    const port = await serveur.demarrer();

    try {
      // « 771234567 » : un numéro de téléphone saisi dans le champ courriel.
      // Aucun rejeu ne le corrigera ; seule une correction de la fiche le peut.
      const echec = envoyerCourriel(configuration(port), {
        destinataire: '771234567',
        objet: 'S',
        corps: 'C',
      });

      await expect(echec).rejects.toThrow(ErreurSmtp);
      await echec.catch((erreur: ErreurSmtp) => {
        expect(erreur.code).toBe(550);
        expect(erreur.definitive).toBe(true);
      });
    } finally {
      await serveur.arreter();
    }
  });

  it('distingue un refus TEMPORAIRE (4xx) — serveur saturé', async () => {
    const serveur = new ServeurSmtpTest({
      refuserMessage: { code: 451, texte: '4.3.0 Réessayez plus tard' },
    });
    const port = await serveur.demarrer();

    try {
      const echec = envoyerCourriel(configuration(port), {
        destinataire: 'awa@exemple.test',
        objet: 'S',
        corps: 'C',
      });

      await expect(echec).rejects.toThrow(ErreurSmtp);
      await echec.catch((erreur: ErreurSmtp) => {
        expect(erreur.code).toBe(451);
        // Le message reste rejouable : c'est le serveur qui est indisponible,
        // pas l'adresse qui est fausse.
        expect(erreur.definitive).toBe(false);
      });
    } finally {
      await serveur.arreter();
    }
  });

  it('rend une erreur claire quand le serveur coupe en plein dialogue', async () => {
    const serveur = new ServeurSmtpTest({ couperApres: 'MAIL' });
    const port = await serveur.demarrer();

    try {
      await expect(
        envoyerCourriel(configuration(port), {
          destinataire: 'awa@exemple.test',
          objet: 'S',
          corps: 'C',
        }),
      ).rejects.toThrow(/fermée/);
    } finally {
      await serveur.arreter();
    }
  });

  it('rend une erreur nommant l\'hôte quand personne n\'écoute', async () => {
    // Port fermé : le cas d'une configuration erronée, qu'un exploitant doit
    // pouvoir diagnostiquer sans lire le code.
    const serveur = new ServeurSmtpTest();
    const port = await serveur.demarrer();
    await serveur.arreter();

    await expect(
      envoyerCourriel(configuration(port, { delaiMs: 2000 }), {
        destinataire: 'awa@exemple.test',
        objet: 'S',
        corps: 'C',
      }),
    ).rejects.toThrow(/127\.0\.0\.1/);
  });
});

describe('ExpediteurSmtp — adaptation à la file', () => {
  it('rend « réussi » et laisse la file marquer le message envoyé', async () => {
    const serveur = new ServeurSmtpTest();
    const port = await serveur.demarrer();

    try {
      const expediteur = new ExpediteurSmtp(configuration(port));
      const resultat = await expediteur.expedier({
        id: 'test-1',
        canal: 'EMAIL',
        adresse: 'awa@exemple.test',
        objet: 'Rappel d\'échéance',
        corps: 'Il reste 15 000 F.',
        destinataire: 'Awa Diop',
      });

      expect(resultat.reussi).toBe(true);
      expect(serveur.recus).toHaveLength(1);
    } finally {
      await serveur.arreter();
    }
  });

  it('rend un ÉCHEC MOTIVÉ plutôt que de lever — la file continue', async () => {
    // Une exception remontée arrêterait le traitement de toute la file sur un
    // seul destinataire. Le service attrape déjà ce cas, mais l'expéditeur ne
    // doit pas en dépendre : il rend un verdict, pas une exception.
    const serveur = new ServeurSmtpTest();
    const port = await serveur.demarrer();
    await serveur.arreter();

    const expediteur = new ExpediteurSmtp(configuration(port, { delaiMs: 2000 }));
    const resultat = await expediteur.expedier({
      id: 'test-2',
      canal: 'EMAIL',
      adresse: 'awa@exemple.test',
      objet: 'S',
      corps: 'C',
      destinataire: 'Awa Diop',
    });

    expect(resultat.reussi).toBe(false);
    expect(resultat.erreur).toBeTruthy();
  });

  it('refuse WhatsApp au lieu de le déclarer envoyé', async () => {
    // Marquer « envoyé » un message qu'on ne sait pas transmettre ferait
    // disparaître de la file une notification que personne n'a reçue.
    const serveur = new ServeurSmtpTest();
    const port = await serveur.demarrer();

    try {
      const expediteur = new ExpediteurSmtp(configuration(port));
      const resultat = await expediteur.expedier({
        id: 'test-3',
        canal: 'WHATSAPP',
        adresse: '+221771234567',
        objet: 'S',
        corps: 'C',
        destinataire: 'Awa Diop',
      });

      expect(resultat.reussi).toBe(false);
      expect(resultat.erreur).toContain('WHATSAPP');
      expect(serveur.recus).toHaveLength(0);
    } finally {
      await serveur.arreter();
    }
  });
});

describe('Configuration SMTP depuis l\'environnement', () => {
  it('rend null sans SMTP_HOTE — le repli est le cas normal', () => {
    expect(configurationDepuisEnvironnement({})).toBeNull();
  });

  it('refuse SMTP_HOTE sans SMTP_EXPEDITEUR, au démarrage', () => {
    // Échouer ici plutôt qu'à l'envoi : une adresse d'expéditeur manquante
    // ferait rejeter chaque message, membre par membre, en fin de file.
    expect(() =>
      configurationDepuisEnvironnement({ SMTP_HOTE: 'smtp.exemple.test' }),
    ).toThrow(/SMTP_EXPEDITEUR/);
  });

  it('refuse un utilisateur sans mot de passe', () => {
    expect(() =>
      configurationDepuisEnvironnement({
        SMTP_HOTE: 'smtp.exemple.test',
        SMTP_EXPEDITEUR: 'tontine@exemple.test',
        SMTP_UTILISATEUR: 'tresorier',
      }),
    ).toThrow(/paire/);
  });

  it('refuse un port hors bornes', () => {
    expect(() =>
      configurationDepuisEnvironnement({
        SMTP_HOTE: 'smtp.exemple.test',
        SMTP_EXPEDITEUR: 'tontine@exemple.test',
        SMTP_PORT: '99999',
      }),
    ).toThrow(/SMTP_PORT/);
  });

  it('déduit le TLS implicite du port 465, STARTTLS ailleurs', () => {
    const base = {
      SMTP_HOTE: 'smtp.exemple.test',
      SMTP_EXPEDITEUR: 'tontine@exemple.test',
    };

    expect(
      configurationDepuisEnvironnement({ ...base, SMTP_PORT: '465' })!
        .tlsImplicite,
    ).toBe(true);
    expect(
      configurationDepuisEnvironnement({ ...base, SMTP_PORT: '587' })!
        .tlsImplicite,
    ).toBe(false);
  });

  it('vérifie les certificats par défaut', () => {
    const config = configurationDepuisEnvironnement({
      SMTP_HOTE: 'smtp.exemple.test',
      SMTP_EXPEDITEUR: 'tontine@exemple.test',
    })!;

    expect(config.accepterCertificatInvalide).toBe(false);
  });
});

describe('Fonctions d\'encodage', () => {
  it('laisse un en-tête ASCII intact, pour la lisibilité des journaux', () => {
    expect(encoderEntete('Reminder')).toBe('Reminder');
  });

  it('encode dès qu\'un caractère sort de l\'ASCII', () => {
    expect(decoderEntete(encoderEntete('Échéance'))).toBe('Échéance');
  });

  it('normalise les fins de ligne en CRLF', () => {
    expect(preparerCorps('a\nb')).toBe('a\r\nb');
    expect(preparerCorps('a\r\nb')).toBe('a\r\nb');
  });

  it('double tout point en début de ligne', () => {
    expect(preparerCorps('.\n.suite')).toBe('..\r\n..suite');
  });
});

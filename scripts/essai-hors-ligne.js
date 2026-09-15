/**
 * Épreuve de la consultation hors-ligne, dans un VRAI navigateur.
 *
 * POURQUOI CE SCRIPT EXISTE. Le code du client hors ligne se lit comme
 * correct et ne l'était pas : la reprise de session appelait le serveur pour
 * vérifier le jeton et déconnectait sur échec — donc déconnectait l'utilisateur
 * et purgeait son cache exactement quand il rouvrait l'application sans réseau.
 * Tout le dispositif était là, et inaccessible dans son seul cas d'usage.
 * Aucune relecture ne l'avait vu ; le premier essai en navigateur l'a montré
 * en trente secondes.
 *
 * COMMENT IL MARCHE. Il pilote Chromium par son protocole de débogage (CDP)
 * sur WebSocket, sans playwright ni puppeteer — aucun des deux n'est
 * installable ici, le registre npm étant injoignable. Le client WebSocket fait
 * une centaine de lignes : c'est le prix d'une vérification réelle plutôt que
 * d'une relecture.
 *
 * CE QU'IL VÉRIFIE :
 *   1. l'application se recharge sans réseau (Service Worker) ;
 *   2. la session survit au rechargement hors ligne ;
 *   3. les données s'affichent depuis l'archive locale ;
 *   4. le bandeau annonce l'âge des données ;
 *   5. plusieurs écrans sont préchargés, pas seulement celui qu'on a ouvert ;
 *   6. une SAISIE est refusée, avec un message qui dit pourquoi ;
 *   7. le retour du réseau efface le bandeau ;
 *   8. la déconnexion purge le cache.
 *
 * PRÉREQUIS : l'API doit tourner sur le port 3100, et la base être peuplée
 * (./scripts/db.sh reinitialiser). Chromium doit être installé.
 *
 * Usage :  node scripts/essai-hors-ligne.js
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT_CDP = 9333;
const BASE = 'http://localhost:3100';

function attendre(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function obtenirJson(chemin) {
  return new Promise((resoudre, rejeter) => {
    http
      .get(`http://127.0.0.1:${PORT_CDP}${chemin}`, (rep) => {
        let d = '';
        rep.on('data', (c) => (d += c));
        rep.on('end', () => {
          try {
            resoudre(JSON.parse(d));
          } catch (e) {
            rejeter(e);
          }
        });
      })
      .on('error', rejeter);
  });
}

/** Client WebSocket minimal — assez pour parler CDP. */
class Ws {
  constructor(url) {
    this.url = new URL(url);
    this.prochainId = 1;
    this.attentes = new Map();
    this.tampon = Buffer.alloc(0);
  }

  connecter() {
    return new Promise((resoudre, rejeter) => {
      const cle = crypto.randomBytes(16).toString('base64');
      this.prise = net.connect(
        Number(this.url.port),
        this.url.hostname,
        () => {
          this.prise.write(
            `GET ${this.url.pathname}${this.url.search} HTTP/1.1\r\n` +
              `Host: ${this.url.host}\r\n` +
              'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
              `Sec-WebSocket-Key: ${cle}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
          );
        },
      );

      let entete = false;
      this.prise.on('data', (morceau) => {
        if (!entete) {
          const texte = morceau.toString('latin1');
          const fin = texte.indexOf('\r\n\r\n');
          if (fin === -1) return;
          if (!texte.includes('101')) {
            rejeter(new Error('Poignée de main refusée : ' + texte.slice(0, 80)));
            return;
          }
          entete = true;
          this.tampon = morceau.slice(fin + 4);
          this.traiter();
          resoudre();
          return;
        }
        this.tampon = Buffer.concat([this.tampon, morceau]);
        this.traiter();
      });

      this.prise.on('error', rejeter);
    });
  }

  traiter() {
    while (this.tampon.length >= 2) {
      const second = this.tampon[1];
      let longueur = second & 0x7f;
      let decalage = 2;

      if (longueur === 126) {
        if (this.tampon.length < 4) return;
        longueur = this.tampon.readUInt16BE(2);
        decalage = 4;
      } else if (longueur === 127) {
        if (this.tampon.length < 10) return;
        longueur = Number(this.tampon.readBigUInt64BE(2));
        decalage = 10;
      }

      if (this.tampon.length < decalage + longueur) return;

      const charge = this.tampon.slice(decalage, decalage + longueur);
      this.tampon = this.tampon.slice(decalage + longueur);

      try {
        const message = JSON.parse(charge.toString('utf8'));
        if (message.id && this.attentes.has(message.id)) {
          const { resoudre, rejeter } = this.attentes.get(message.id);
          this.attentes.delete(message.id);
          message.error ? rejeter(new Error(message.error.message)) : resoudre(message.result);
        }
      } catch (e) {
        /* trame de contrôle : sans intérêt ici */
      }
    }
  }

  envoyer(objet) {
    const charge = Buffer.from(JSON.stringify(objet), 'utf8');
    const masque = crypto.randomBytes(4);
    const masquee = Buffer.alloc(charge.length);
    for (let i = 0; i < charge.length; i += 1) masquee[i] = charge[i] ^ masque[i % 4];

    let entete;
    if (charge.length < 126) {
      entete = Buffer.from([0x81, 0x80 | charge.length]);
    } else if (charge.length < 65536) {
      entete = Buffer.alloc(4);
      entete[0] = 0x81;
      entete[1] = 0x80 | 126;
      entete.writeUInt16BE(charge.length, 2);
    } else {
      entete = Buffer.alloc(10);
      entete[0] = 0x81;
      entete[1] = 0x80 | 127;
      entete.writeBigUInt64BE(BigInt(charge.length), 2);
    }

    this.prise.write(Buffer.concat([entete, masque, masquee]));
  }

  commande(methode, params = {}) {
    const id = this.prochainId++;
    return new Promise((resoudre, rejeter) => {
      this.attentes.set(id, { resoudre, rejeter });
      this.envoyer({ id, method: methode, params });
      setTimeout(() => {
        if (this.attentes.has(id)) {
          this.attentes.delete(id);
          rejeter(new Error(`Délai dépassé : ${methode}`));
        }
      }, 30000);
    });
  }
}

const resultats = [];
function verifier(nom, condition, detail = '') {
  resultats.push({ nom, ok: Boolean(condition), detail });
  console.log(`  ${condition ? '✓' : '✗'} ${nom}${detail ? ' — ' + detail : ''}`);
}

async function principal() {
  // Profil jetable, recréé à chaque essai : un profil conservé garderait le
  // Service Worker et le cache d'un passage précédent, et l'essai vérifierait
  // alors l'état d'hier plutôt que le code d'aujourd'hui.
  const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'tontine-essai-'));

  // Chromium est cherché aux emplacements usuels plutôt que codé en dur : le
  // chemin varie selon la distribution et le mode d'installation (snap, apt,
  // Chrome).
  const candidats = [
    process.env.CHROMIUM,
    '/snap/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean);

  const chromium = candidats.find((c) => fs.existsSync(c));
  if (!chromium) {
    throw new Error(
      'Chromium introuvable. Installez-le, ou indiquez son chemin :\n'
        + '  CHROMIUM=/chemin/vers/chromium node scripts/essai-hors-ligne.js',
    );
  }

  const navigateur = spawn(
    chromium,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT_CDP}`,
      `--user-data-dir=${profil}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
    ],
    { stdio: 'ignore' },
  );

  try {
    // Attente de la disponibilité du protocole.
    let cible = null;
    for (let i = 0; i < 40; i += 1) {
      await attendre(500);
      try {
        const liste = await obtenirJson('/json/list');
        cible = liste.find((c) => c.type === 'page');
        if (cible) break;
      } catch (e) {
        /* pas encore prêt */
      }
    }
    if (!cible) throw new Error('Chromium n\'a pas exposé de page');

    const ws = new Ws(cible.webSocketDebuggerUrl);
    await ws.connecter();

    await ws.commande('Page.enable');
    await ws.commande('Runtime.enable');
    await ws.commande('Network.enable');

    const evaluer = async (expression) => {
      const r = await ws.commande('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error(
          r.exceptionDetails.exception?.description ||
            r.exceptionDetails.text,
        );
      }
      return r.result.value;
    };

    // ON CLIQUE SUR L'ONGLET, comme un utilisateur. Appeler `afficher()`
    // depuis la console ne marche plus depuis le passage en modules ES — et
    // c'était de toute façon un raccourci : ce qui doit fonctionner, c'est le
    // chemin que prend une vraie personne.
    const ouvrirOnglet = async (libelle) => {
      const trouve = await evaluer(`
        (() => {
          const LIBELLE = ${JSON.stringify(libelle)};
          const b = [...document.querySelectorAll('#onglets button')]
            .find((x) => x.textContent.trim() === LIBELLE);
          if (!b) return false;
          b.click();
          return true;
        })()
      `);
      await attendre(2500);
      return trouve;
    };

    console.log('\n--- 1. Chargement en ligne et connexion ---');
    await ws.commande('Page.navigate', { url: BASE + '/' });
    await attendre(3000);

    const titre = await evaluer('document.title');
    verifier('la page se charge', typeof titre === 'string' && titre.length > 0, titre);

    // Connexion par l'interface réelle, pas en trichant sur le stockage.
    await evaluer(`
      (async () => {
        document.getElementById('telephone').value = '+237690110002';
        document.getElementById('mot-de-passe').value = 'tontine2026';
        document.getElementById('formulaire-connexion')
          .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      })()
    `);
    await attendre(3000);

    const connecte = await evaluer(
      'document.getElementById("application").hidden === false',
    );
    verifier('la connexion réussit', connecte);

    if (!connecte) {
      const err = await evaluer(
        'document.getElementById("erreur-connexion").textContent',
      );
      console.log('    erreur affichée : ' + err);
    }

    // Le préchargement est séquentiel : on lui laisse le temps d'aboutir.
    await attendre(6000);
    const archive = await evaluer(`
      Object.keys(localStorage)
        .filter(c => c.startsWith('tontine.cache.'))
        .map(c => c.split('.').slice(3).join('.'))
    `);
    verifier(
      'les lectures sont archivées',
      archive.length > 0,
      archive.length + ' entrée(s)',
    );
    verifier(
      'plusieurs écrans sont préchargés',
      archive.length >= 4,
      archive.join(' '),
    );

    // Le Service Worker doit être actif pour que le rechargement marche.
    const swActif = await evaluer(`
      navigator.serviceWorker.getRegistration('/').then(r => !!(r && r.active))
    `);
    verifier('le Service Worker est actif', swActif);

    console.log('\n--- 1 bis. Le découpage est-il effectif ? ---');

    // LA VÉRIFICATION QUI JUSTIFIE TOUT LE DÉCOUPAGE. Un registre d'écrans
    // différés ne sert à rien si le navigateur les télécharge quand même au
    // démarrage. On lit les ressources réellement demandées : celles d'un
    // mécanisme étranger au groupe ne doivent PAS y figurer.
    //
    // La trésorière de démonstration préside une ROSCA : elle doit avoir
    // ecrans-rosca.js (l'onglet « Tours » est visible) et jamais
    // ecrans-asca.js ni ecrans-mutuelle.js.
    const charges = await evaluer(`
      performance.getEntriesByType('resource')
        .map((r) => r.name.split('/').pop())
        .filter((n) => n.endsWith('.js'))
    `);

    verifier(
      'les écrans d\'un AUTRE mécanisme ne sont pas téléchargés',
      !charges.includes('ecrans-asca.js') && !charges.includes('ecrans-mutuelle.js'),
      charges.join(' '),
    );

    verifier(
      'la reprise de cahier n\'est pas téléchargée sans être ouverte',
      !charges.includes('ecran-import.js'),
    );

    console.log('\n--- 2. Coupure du réseau ---');
    await ws.commande('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });

    // Rechargement complet SANS réseau : c'est le cas du trésorier qui rouvre
    // l'application en réunion.
    await ws.commande('Page.reload');
    await attendre(4000);

    const titreHorsLigne = await evaluer('document.title');
    verifier(
      'l\'application se recharge sans réseau',
      typeof titreHorsLigne === 'string' && titreHorsLigne.length > 0,
      titreHorsLigne,
    );

    const appVisible = await evaluer(
      'document.getElementById("application").hidden === false',
    );
    verifier('la session survit au rechargement hors ligne', appVisible);

    await attendre(2500);

    const bandeau = await evaluer(`
      (() => {
        const b = document.getElementById('bandeau-hors-ligne');
        return b && !b.hidden ? b.textContent : '';
      })()
    `);
    verifier(
      'le bandeau hors ligne apparaît',
      bandeau.includes('Hors ligne'),
      bandeau.slice(0, 70),
    );
    verifier(
      'le bandeau donne l\'âge des données',
      /il y a|le \d/.test(bandeau),
      bandeau.match(/il y a[^.]*/)?.[0] || '',
    );

    const contenu = await evaluer(
      'document.getElementById("contenu").textContent.trim().length',
    );
    verifier(
      'les données s\'affichent depuis l\'archive',
      contenu > 100,
      contenu + ' caractères',
    );

    console.log('\n--- 3. La saisie est refusée hors ligne ---');

    // PAR L'INTERFACE, ET NON EN APPELANT `appel()` DEPUIS LA CONSOLE.
    // Une version précédente le faisait — elle a cessé de fonctionner au
    // passage en modules ES, qui n'exposent plus rien globalement. C'était en
    // réalité une faiblesse du test : il vérifiait une fonction interne, là où
    // ce qui compte est ce que voit le trésorier en cliquant.
    await ouvrirOnglet('Saisir');

    const refus = await evaluer(`
      (async () => {
        const bouton = document.getElementById('valider');
        if (!bouton) return "L'écran de saisie ne s'est pas affiché";
        const montant = document.getElementById('montant');
        if (montant) montant.value = '1000';
        bouton.click();
        await new Promise((r) => setTimeout(r, 1500));
        const boite = document.getElementById('message');
        return boite && !boite.hidden ? boite.textContent : '(aucun message)';
      })()
    `);

    verifier(
      'un versement hors ligne est refusé, avec un message clair',
      refus.includes('Pas de réseau') && refus.includes('compter double'),
      refus.slice(0, 80),
    );

    console.log('\n--- 4. Retour du réseau ---');
    await ws.commande('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await evaluer('window.dispatchEvent(new Event("online"))');
    await attendre(3000);

    const bandeauApres = await evaluer(`
      document.getElementById('bandeau-hors-ligne').hidden
    `);
    verifier('le bandeau disparaît au retour du réseau', bandeauApres === true);

    console.log('\n--- 5. Cloisonnement du cache ---');
    const avantDeco = await evaluer(`
      Object.keys(localStorage).filter(c => c.startsWith('tontine.cache.')).length
    `);
    // Par le bouton « Quitter », comme un utilisateur — `deconnecter()` n'est
    // plus une fonction globale depuis le passage en modules ES.
    await evaluer('document.getElementById("deconnexion").click()');
    await attendre(1000);
    const apresDeco = await evaluer(`
      Object.keys(localStorage).filter(c => c.startsWith('tontine.cache.')).length
    `);
    verifier(
      'la déconnexion purge le cache',
      avantDeco > 0 && apresDeco === 0,
      `${avantDeco} -> ${apresDeco}`,
    );

    console.log('\n========================================');
    const echecs = resultats.filter((r) => !r.ok);
    console.log(
      `${resultats.length - echecs.length}/${resultats.length} vérifications passées`,
    );
    if (echecs.length) {
      console.log('ÉCHECS :');
      echecs.forEach((e) => console.log('  - ' + e.nom));
    }
    process.exitCode = echecs.length ? 1 : 0;
  } finally {
    navigateur.kill();
    fs.rmSync(profil, { recursive: true, force: true });
  }
}

principal().catch((e) => {
  console.error('\nERREUR : ' + e.message);
  process.exitCode = 1;
});

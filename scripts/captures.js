/**
 * Captures de l'interface, pour la documentation et le portfolio.
 *
 * POURQUOI UN SCRIPT PLUTÔT QUE DES CAPTURES À LA MAIN. Les images d'un
 * portfolio vieillissent mal : l'interface change, et personne ne pense à les
 * refaire. Ici, une commande suffit — et chaque écran est pris avec LE RÔLE QUI
 * L'UTILISE VRAIMENT. Une capture prise avec un compte tout-puissant montrerait
 * des boutons que l'utilisateur réel n'a pas, ce qui est une forme de mensonge.
 *
 * IL REFUSE DE CAPTURER UN ÉCRAN VIDE. Un écran resté sur « Chargement… » ou
 * dont les données manquent produit un fichier d'apparence normale ; c'est
 * précisément le genre d'image qu'on publie sans la regarder. Le script le
 * signale et passe.
 *
 * PRÉREQUIS : l'API sur le port 3100, la base peuplée
 * (./scripts/db.sh reinitialiser). Chromium installé.
 *
 * Pour que l'écran des anomalies montre autre chose que « Rien à vérifier »,
 * lancer d'abord le balayage :
 *
 *   docker exec tontine-db psql -U tontine_app -d tontine \
 *     -c "SELECT balayer_anomalies(id) FROM groupe"
 *
 * Usage :  node scripts/captures.js [dossier-de-sortie]
 *          SEULEMENT=1 node scripts/captures.js   (anomalies seules)
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


/* ---------------------------------------------------------------- écrans ---

   CE QUI EST CAPTURÉ, ET AVEC QUEL COMPTE. Chaque écran est pris avec le rôle
   qui l'utilise vraiment : la saisie par la trésorière, le rapport par la
   présidente. Une capture prise avec un compte tout-puissant montrerait des
   boutons que l'utilisateur réel n'a pas. */

const COMPTES = {
  tresoriere: { tel: '+237690110002', mdp: 'tontine2026' },
  presidente: { tel: '+237690110001', mdp: 'tontine2026' },
  asca:       { tel: '+237677220001', mdp: 'tontine2026' },
};

const ECRANS = (process.env.SEULEMENT
  ? [{ fichier: 'anomalies', compte: 'presidente', onglet: 'À vérifier',
       legende: 'Détection d\'anomalies' }]
  : [
  { fichier: 'saisie',      compte: 'tresoriere', onglet: 'Saisir',     legende: 'Saisie d\'un versement' },
  { fichier: 'situation',   compte: 'tresoriere', onglet: 'Situation',  legende: 'Situation du groupe' },
  { fichier: 'impayes',     compte: 'tresoriere', onglet: 'Impayés',    legende: 'Impayés du tour' },
  { fichier: 'tours',       compte: 'tresoriere', onglet: 'Tours',      legende: 'Tour de rôle' },
  { fichier: 'anomalies',   compte: 'presidente', onglet: 'À vérifier', legende: 'Détection d\'anomalies' },
  { fichier: 'rapport',     compte: 'presidente', onglet: 'Rapport',    legende: 'Rapport d\'assemblée' },
  { fichier: 'historique',  compte: 'presidente', onglet: 'Historique', legende: 'Traçabilité' },
  { fichier: 'prets',       compte: 'asca',       onglet: 'Prêts',      legende: 'Prêts (ASCA)' },
]);

const SORTIE = process.argv[2] || '/tmp/captures-tontine';

async function principal() {
  const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'captures-'));
  const candidats = [process.env.CHROMIUM, '/snap/bin/chromium', '/usr/bin/chromium',
                     '/usr/bin/chromium-browser'].filter(Boolean);
  const chromium = candidats.find((c) => fs.existsSync(c));
  if (!chromium) throw new Error('Chromium introuvable');

  fs.mkdirSync(SORTIE, { recursive: true });

  const navigateur = spawn(chromium, [
    '--headless=new', `--remote-debugging-port=${PORT_CDP}`,
    `--user-data-dir=${profil}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars',
  ], { stdio: 'ignore' });

  try {
    let cible = null;
    for (let i = 0; i < 40; i += 1) {
      await attendre(500);
      try {
        cible = (await obtenirJson('/json/list')).find((c) => c.type === 'page');
        if (cible) break;
      } catch (e) { /* pas encore prêt */ }
    }
    if (!cible) throw new Error('Chromium n\'a pas exposé de page');

    const ws = new Ws(cible.webSocketDebuggerUrl);
    await ws.connecter();
    await ws.commande('Page.enable');
    await ws.commande('Runtime.enable');
    await ws.commande('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });

    const ev = async (expression) => {
      const r = await ws.commande('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description
                        || r.exceptionDetails.text);
      }
      return r.result.value;
    };

    const connecter = async ({ tel, mdp }) => {
      await ws.commande('Page.navigate', { url: BASE + '/' });
      await attendre(2500);
      await ev(`
        document.getElementById('telephone').value = ${JSON.stringify(tel)};
        document.getElementById('mot-de-passe').value = ${JSON.stringify(mdp)};
        document.getElementById('formulaire-connexion')
          .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      `);
      await attendre(3500);
      return ev('document.getElementById("application").hidden === false');
    };

    const capturer = async (nom) => {
      const r = await ws.commande('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: false,
      });
      const chemin = path.join(SORTIE, nom + '.png');
      fs.writeFileSync(chemin, Buffer.from(r.data, 'base64'));
      return fs.statSync(chemin).size;
    };

    let compteCourant = null;
    let prises = 0;

    // L'écran de connexion, avant toute session.
    await ws.commande('Page.navigate', { url: BASE + '/' });
    await attendre(2500);
    console.log(`  ${'connexion'.padEnd(14)} ${(await capturer('connexion') / 1024).toFixed(0)} ko`);
    prises += 1;

    for (const ecran of ECRANS) {
      if (compteCourant !== ecran.compte) {
        const ok = await connecter(COMPTES[ecran.compte]);
        if (!ok) {
          console.log(`  ${ecran.fichier.padEnd(14)} ÉCHEC de connexion (${ecran.compte})`);
          continue;
        }
        compteCourant = ecran.compte;
      }

      const trouve = await ev(`
        (() => {
          const LIBELLE = ${JSON.stringify(ecran.onglet)};
          const b = [...document.querySelectorAll('#onglets button')]
            .find((x) => x.textContent.trim() === LIBELLE);
          if (!b) return false;
          b.click();
          return true;
        })()
      `);

      if (!trouve) {
        const dispo = await ev(
          `[...document.querySelectorAll('#onglets button')].map(b => b.textContent.trim()).join(' | ')`);
        console.log(`  ${ecran.fichier.padEnd(14)} ONGLET ABSENT « ${ecran.onglet} » — présents : ${dispo}`);
        continue;
      }

      // Le temps que l'écran charge ses données ET son module, le cas échéant.
      await attendre(3000);

      const vide = await ev(
        'document.getElementById("contenu").textContent.trim().length < 40');
      if (vide) {
        console.log(`  ${ecran.fichier.padEnd(14)} ÉCRAN VIDE — capture inutile`);
        continue;
      }

      const poids = await capturer(ecran.fichier);
      console.log(`  ${ecran.fichier.padEnd(14)} ${(poids / 1024).toFixed(0).padStart(4)} ko   ${ecran.legende}`);
      prises += 1;
    }

    console.log(`\n  ${prises} capture(s) dans ${SORTIE}`);
  } finally {
    navigateur.kill();
    fs.rmSync(profil, { recursive: true, force: true });
  }
}

principal().catch((e) => {
  console.error('\nERREUR : ' + e.message);
  process.exitCode = 1;
});

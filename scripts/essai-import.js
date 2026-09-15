/**
 * Épreuve de l'écran de reprise de cahier, dans un VRAI navigateur.
 *
 * CE QU'IL VÉRIFIE — le parcours entier, tel qu'un président le vit :
 *   1. l'onglet « Reprendre un cahier » n'apparaît que pour un groupe neuf ;
 *   2. le dépôt d'un CSV produit un apercu lisible (membres, ordre de passage,
 *      montant total) ;
 *   3. l'apercu N'ECRIT RIEN — c'est la seule protection du trésorier, le
 *      journal étant immuable et un import regretté indéfaisable ;
 *   4. la validation crée le cycle et les tours ;
 *   5. l'onglet disparaît ensuite, sans reconnexion.
 *
 * PREREQUIS. L'API sur le port 3100, et un groupe NEUF avec un compte —
 * voir le bloc SQL en fin de fichier. Le groupe ne sert qu'une fois : un
 * cahier ne se reprend pas deux fois.
 *
 * Usage :  node scripts/essai-import.js
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


const CAHIER = [
  'nom;telephone;rang;tour;date;montant;moyen',
  'Mariama Sow;+237690990001;1;1;06/01/2025;10000;especes',
  'Aicha Bello;+237690990002;2;1;06/01/2025;10000;especes',
  'Fatou Ngo;+237690990003;3;1;07/01/2025;10000;momo',
  'Mariama Sow;+237690990001;1;2;06/02/2025;10000;especes',
  'Aicha Bello;+237690990002;2;2;06/02/2025;10000;especes',
  'Fatou Ngo;+237690990003;3;2;08/02/2025;10000;especes',
].join('\n');

async function principal() {
  const profil = fs.mkdtempSync(path.join(os.tmpdir(), 'tontine-import-'));
  const candidats = [process.env.CHROMIUM, '/snap/bin/chromium', '/usr/bin/chromium'].filter(Boolean);
  const chromium = candidats.find((c) => fs.existsSync(c));

  const navigateur = spawn(chromium, [
    '--headless=new', `--remote-debugging-port=${PORT_CDP}`,
    `--user-data-dir=${profil}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  ], { stdio: 'ignore' });

  try {
    let cible = null;
    for (let i = 0; i < 40; i += 1) {
      await attendre(500);
      try {
        const liste = await obtenirJson('/json/list');
        cible = liste.find((c) => c.type === 'page');
        if (cible) break;
      } catch (e) { /* pas prêt */ }
    }
    if (!cible) throw new Error('Chromium indisponible');

    const ws = new Ws(cible.webSocketDebuggerUrl);
    await ws.connecter();
    await ws.commande('Page.enable');
    await ws.commande('Runtime.enable');

    const evaluer = async (expression) => {
      const r = await ws.commande('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };

    // ON CLIQUE SUR L'ONGLET, comme un utilisateur. Appeler `afficher()`
    // depuis la console ne marche plus depuis le passage en modules ES — et
    // c'était de toute façon un raccourci : ce qui doit fonctionner, c'est le
    // chemin que prend une vraie personne, y compris le téléchargement du
    // module de l'écran.
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

    console.log('\n--- Connexion au groupe NEUF ---');
    await ws.commande('Page.navigate', { url: BASE + '/' });
    await attendre(3000);

    await evaluer(`
      document.getElementById('telephone').value = '+237690990001';
      document.getElementById('mot-de-passe').value = 'tontine2026';
      document.getElementById('formulaire-connexion').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    `);
    await attendre(3500);

    verifier('connexion réussie', await evaluer('document.getElementById("application").hidden === false'));

    const onglets = await evaluer(`[...document.querySelectorAll('#onglets button')].map(b => b.textContent.trim())`);
    verifier("l'onglet d'import est proposé à un groupe neuf", onglets.includes('Reprendre un cahier'), onglets.join(' | '));

    console.log('\n--- Écran d\'import ---');
    await ouvrirOnglet('Reprendre un cahier');

    const texteEcran = await evaluer('document.getElementById("contenu").textContent');
    verifier("l'écran s'affiche", texteEcran.includes('Reprendre un cahier existant'));
    verifier("l'aide sur les colonnes est présente", texteEcran.includes('telephone'));

    console.log('\n--- Dépôt du fichier et aperçu ---');
    // On injecte le contenu comme le ferait un vrai dépôt de fichier.
    await evaluer(`
      (async () => {
        const fichier = new File([${JSON.stringify(CAHIER)}], 'cahier-2025.csv', { type: 'text/csv' });
        const dt = new DataTransfer();
        dt.items.add(fichier);
        const input = document.getElementById('fichier-cahier');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `);
    await attendre(2500);

    const apercu = await evaluer('document.getElementById("apercu-cahier").textContent');
    verifier("l'aperçu montre 3 membres", /3\s*membres/.test(apercu), apercu.slice(0, 60).replace(/\s+/g, ' '));
    verifier("l'aperçu montre 6 versements", /6\s*versements/.test(apercu));
    verifier("l'aperçu montre l'ordre de passage", apercu.includes('Mariama Sow') && apercu.includes('tour 1'));
    verifier("l'aperçu montre le montant total", /60[\s\u00a0]?000/.test(apercu));

    const cyclesAvant = await evaluer(`
      fetch('/api/tours', { headers: { Authorization: 'Bearer ' + JSON.parse(sessionStorage.getItem('tontine')).jeton } })
        .then(r => r.json()).then(t => Array.isArray(t) ? t.length : -1)
    `);
    verifier("l'aperçu N'A RIEN ÉCRIT", cyclesAvant === 0, cyclesAvant + ' tour(s)');

    console.log('\n--- Validation ---');
    await evaluer(`
      document.getElementById('cotisation').value = '10000';
      document.getElementById('debut').value = '2025-01-06';
      document.getElementById('valider-import').click();
    `);
    await attendre(4000);

    const messageFinal = await evaluer('document.getElementById("message").textContent');
    verifier("l'import est confirmé", messageFinal.includes('Cahier repris'), messageFinal);

    const apresOnglets = await evaluer(`[...document.querySelectorAll('#onglets button')].map(b => b.textContent.trim())`);
    verifier("l'onglet d'import disparaît après reprise", !apresOnglets.includes('Reprendre un cahier'));

    const tours = await evaluer(`
      fetch('/api/tours', { headers: { Authorization: 'Bearer ' + JSON.parse(sessionStorage.getItem('tontine')).jeton } })
        .then(r => r.json()).then(t => t.length)
    `);
    verifier('trois tours ont été créés', tours === 3, tours + ' tour(s)');

    console.log('\n========================================');
    const echecs = resultats.filter((r) => !r.ok);
    console.log(`${resultats.length - echecs.length}/${resultats.length} vérifications passées`);
    echecs.forEach((e) => console.log('  ÉCHEC : ' + e.nom));
    process.exitCode = echecs.length ? 1 : 0;
  } finally {
    navigateur.kill();
    fs.rmSync(profil, { recursive: true, force: true });
  }
}

principal().catch((e) => { console.error('\nERREUR : ' + e.message); process.exitCode = 1; });

/* PREPARATION DU GROUPE D'ESSAI — à jouer avant, une seule fois :

docker exec -i -e PGPASSWORD=dev tontine-db psql -U postgres -d tontine <<'SQL'
INSERT INTO groupe (nom, type, devise, date_creation)
VALUES ('Tontine des couturieres', 'ROSCA', 'XAF', '2025-01-06') RETURNING id \gset g_
INSERT INTO membre (groupe_id, nom_complet, telephone, date_adhesion)
VALUES (:'g_id', 'Mariama Sow', '+237690990001', '2025-01-06') RETURNING id \gset m_
INSERT INTO membre_role (membre_id, role, attribue_le)
VALUES (:'m_id', 'PRESIDENT', '2025-01-06');
INSERT INTO utilisateur (membre_id, telephone, mot_de_passe_hash, actif)
SELECT :'m_id', '+237690990001', u.mot_de_passe_hash, true FROM utilisateur u LIMIT 1;
SQL
*/

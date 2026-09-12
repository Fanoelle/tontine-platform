/* ==========================================================================
   Client de la plateforme de tontines

   AUCUNE DÉPENDANCE, AUCUNE ÉTAPE DE CONSTRUCTION. Le fichier servi est le
   fichier écrit (voir index.html pour l'arbitrage).

   RÈGLE DE VOCABULAIRE, TENUE PARTOUT DANS CE FICHIER : aucun mot de
   comptabilité n'atteint l'utilisateur (N-USG-05). Pas de « débit », pas de
   « crédit », pas d'« écriture ». On annule un versement, on ne passe pas
   d'écriture inverse. Et le mot « payer » n'apparaît nulle part : la
   plateforme n'encaisse rien, elle enregistre des versements faits ailleurs.
   ========================================================================== */

'use strict';

const API = '/api';

/* État de session. Le jeton vit en mémoire ET dans sessionStorage : en mémoire
   pour l'usage courant, en sessionStorage pour survivre à un rechargement de
   page — fréquent sur un téléphone qui bascule d'application. sessionStorage
   et non localStorage : la session s'efface à la fermeture de l'onglet, ce qui
   convient à un appareil parfois partagé au sein du groupe. */
let session = {
  jeton: null,
  membre: null,
  groupe: null,
};

let ongletCourant = null;

/* ENREGISTREMENT DU SERVICE WORKER — c'est lui qui rend l'application
   ouvrable sans réseau. L'échec est silencieux et sans conséquence : en
   navigation privée, sur une origine non sécurisée ou dans un navigateur
   ancien, l'application fonctionne exactement comme avant, simplement sans
   consultation hors ligne.

   `load` plutôt qu'immédiatement : l'installation télécharge la coquille, et
   la faire concourir avec le premier affichage ralentirait précisément ce
   qu'on cherche à rendre rapide. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* hors ligne indisponible : l'application reste pleinement utilisable */
    });
  });
}

/* Le retour du réseau efface le bandeau et recharge l'écran courant : rester
   sur des données archivées alors que la connexion est revenue serait le
   défaut le plus agaçant de cette fonctionnalité. */
window.addEventListener('online', () => {
  signalerHorsLigne(null);
  if (ongletCourant) afficher(ongletCourant);
});

/* ---------------------------------------------------------------- outils --- */

/** Échappement systématique : toute donnée vient du serveur, donc d'une
    saisie humaine. Un nom de membre contenant « <script> » ne doit pas
    s'exécuter. C'est la seule défense nécessaire ici, et elle doit être
    appliquée sans exception. */
function txt(valeur) {
  if (valeur === null || valeur === undefined) return '';
  return String(valeur)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Les montants arrivent en CHAÎNE : le pilote `pg` sérialise ainsi les BIGINT
    pour ne pas perdre de précision au-delà de 2^53. Cohérent avec N-INT-03 —
    les montants sont des entiers exacts, jamais des flottants.
    Espace insécable comme séparateur, et aucune décimale : le franc CFA n'a
    pas de sous-unité en pratique. */
function francs(valeur) {
  const n = Number(valeur ?? 0);
  return n.toLocaleString('fr-FR').replace(/ |\s/g, ' ') + ' F';
}

function date(valeur) {
  if (!valeur) return '';
  const d = new Date(valeur);
  if (Number.isNaN(d.getTime())) return String(valeur);
  return d.toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

function dateCourte(valeur) {
  if (!valeur) return '';
  const d = new Date(valeur);
  if (Number.isNaN(d.getTime())) return String(valeur);
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function aujourdhui() {
  return new Date().toISOString().slice(0, 10);
}

function message(texte, genre = '') {
  const boite = document.getElementById('message');
  boite.textContent = texte;
  boite.className = 'message ' + genre;
  boite.hidden = false;
  clearTimeout(message.minuteur);
  message.minuteur = setTimeout(() => { boite.hidden = true; }, 4500);
}

/* ---------------------------------------------------- consultation hors-ligne ---

   CE QUE ÇA RÉSOUT. Une tontine se tient là où le réseau est faible : une cour,
   un arrière-boutique, une salle de réunion en sous-sol. Le trésorier qui ouvre
   la plateforme devant le groupe pour répondre à « combien ai-je versé ? » ne
   peut pas répondre « attends que ça charge ».

   CE QUI EST ET N'EST PAS PERMIS HORS LIGNE. On lit, on n'écrit pas. Un
   versement saisi hors ligne devrait être rejoué plus tard contre une base qui
   aura changé : l'échéance visée peut avoir été réglée entre-temps, dispensée,
   ou le tour remis. Rejouer aveuglément produirait des doublons dans un journal
   immuable — impossible à corriger autrement qu'en annulant, ce qui laisse deux
   écritures là où il n'aurait dû y en avoir aucune.

   La saisie hors ligne est donc REFUSÉE, explicitement, avec un message qui dit
   pourquoi. Un trésorier qui note le versement sur son cahier et le saisit en
   rentrant perd cinq minutes ; un trésorier dont la plateforme a doublé trois
   cotisations perd la confiance du groupe.

   LES DONNÉES SONT CLOISONNÉES PAR UTILISATEUR ET EFFACÉES À LA DÉCONNEXION.
   Ce cache contient des montants, des noms, des impayés — exactement ce qu'un
   membre ne doit pas pouvoir lire du groupe d'un autre. La clé porte
   l'identifiant du membre, et `deconnecter()` vide tout. */

const CACHE_PREFIXE = 'tontine.cache.';
const CACHE_AGE_MAXIMAL = 7 * 24 * 3600 * 1000;

function cacheCle(chemin) {
  const qui = (session.membre && session.membre.id) || 'anonyme';
  return CACHE_PREFIXE + qui + '.' + chemin;
}

/** Archive une réponse. Les échecs de stockage sont ignorés : un quota plein
    ou un navigateur en navigation privée ne doit pas casser une page qui
    vient de s'afficher correctement. */
function archiver(chemin, corps) {
  try {
    localStorage.setItem(cacheCle(chemin), JSON.stringify({
      quand: Date.now(),
      corps,
    }));
  } catch (e) {
    // Quota dépassé : on fait de la place en retirant les entrées de cet
    // utilisateur, plutôt que de laisser le cache se figer sur des données
    // anciennes qu'on ne pourrait plus rafraîchir.
    try { purgerCache(); } catch (_) { /* rien de mieux à tenter */ }
  }
}

function relire(chemin) {
  try {
    const brut = localStorage.getItem(cacheCle(chemin));
    if (!brut) return null;

    const entree = JSON.parse(brut);

    // UNE DONNÉE TROP ANCIENNE EST PIRE QUE PAS DE DONNÉE. Un solde de la
    // semaine dernière présenté comme courant induirait en erreur là où un
    // écran vide ferait au moins comprendre qu'il faut du réseau.
    if (Date.now() - entree.quand > CACHE_AGE_MAXIMAL) {
      localStorage.removeItem(cacheCle(chemin));
      return null;
    }

    return entree;
  } catch (e) {
    return null;
  }
}

function purgerCache() {
  const aRetirer = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const cle = localStorage.key(i);
    if (cle && cle.startsWith(CACHE_PREFIXE)) aRetirer.push(cle);
  }
  aRetirer.forEach((cle) => localStorage.removeItem(cle));
}

/** Affiche — ou retire — le bandeau « hors ligne ». */
function signalerHorsLigne(entree) {
  const bandeau = document.getElementById('bandeau-hors-ligne');
  if (!bandeau) return;

  if (!entree) {
    bandeau.hidden = true;
    return;
  }

  const minutes = Math.round((Date.now() - entree.quand) / 60000);
  const age = minutes < 60
    ? 'il y a ' + minutes + ' min'
    : (minutes < 1440
        ? 'il y a ' + Math.round(minutes / 60) + ' h'
        : 'le ' + dateCourte(new Date(entree.quand).toISOString()));

  bandeau.textContent = 'Hors ligne — données consultées ' + age
    + '. La saisie est indisponible tant que le réseau ne revient pas.';
  bandeau.hidden = false;
}

/** Appel à l'API. Le jeton est joint systématiquement ; un 401 ramène à la
    connexion plutôt que d'afficher une erreur incompréhensible.

    LES LECTURES SONT ARCHIVÉES ET SERVIES HORS LIGNE ; les écritures sont
    refusées. Voir le commentaire ci-dessus pour le pourquoi. */
async function appel(chemin, options = {}) {
  const methode = (options.method || 'GET').toUpperCase();
  const lecture = methode === 'GET';

  let reponse;
  try {
    reponse = await fetch(API + chemin, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(session.jeton ? { Authorization: 'Bearer ' + session.jeton } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (e) {
    // `fetch` ne rejette que sur une panne réseau — un 500 est une réponse.
    // C'est donc bien ici, et seulement ici, qu'on est hors ligne.
    if (!lecture) {
      throw new Error(
        'Pas de réseau — la saisie est impossible hors ligne. Notez '
        + "l'opération et enregistrez-la dès que la connexion revient : "
        + 'un versement rejoué à l\'aveugle risquerait de compter double.',
      );
    }

    const entree = relire(chemin);
    if (!entree) {
      throw new Error(
        'Pas de réseau, et cet écran n\'a pas encore été consulté en ligne. '
        + 'Ouvrez-le une fois connecté pour pouvoir le relire hors ligne.',
      );
    }

    signalerHorsLigne(entree);
    return entree.corps;
  }

  if (reponse.status === 401 && session.jeton) {
    deconnecter();
    throw new Error('Votre session a expiré, reconnectez-vous.');
  }

  const corps = await reponse.json().catch(() => null);

  if (!reponse.ok) {
    // Les messages du serveur sont déjà rédigés pour un humain — « Le versement
    // de 25000 F dépasse le reste dû de 15000 F ». Les relayer vaut mieux que
    // de les remplacer par un texte générique : le trésorier doit comprendre
    // ce qui est refusé.
    const m = corps && corps.message;
    throw new Error(Array.isArray(m) ? m.join('. ') : (m || 'Opération refusée'));
  }

  // Le réseau répond : on sort de l'état hors ligne et on rafraîchit l'archive.
  signalerHorsLigne(null);
  if (lecture && corps !== null) archiver(chemin, corps);

  return corps;
}

function aRole(role) {
  return session.membre && session.membre.roles.includes(role);
}

/* ------------------------------------------------------------- connexion --- */

document.getElementById('formulaire-connexion').addEventListener('submit', async (e) => {
  e.preventDefault();
  const bouton = e.target.querySelector('button');
  const erreur = document.getElementById('erreur-connexion');

  bouton.disabled = true;
  bouton.textContent = 'Connexion…';
  erreur.hidden = true;

  try {
    const resultat = await appel('/authentification/connexion', {
      method: 'POST',
      body: JSON.stringify({
        telephone: document.getElementById('telephone').value.trim(),
        mot_de_passe: document.getElementById('mot-de-passe').value,
      }),
    });

    session = {
      jeton: resultat.jeton,
      membre: resultat.membre,
      groupe: resultat.groupe,
    };

    try {
      sessionStorage.setItem('tontine', JSON.stringify(session));
    } catch {
      // Navigation privée ou stockage refusé : la session reste en mémoire.
      // L'application fonctionne, elle ne survivra simplement pas à un
      // rechargement. Ce n'est pas une raison d'échouer.
    }

    demarrer();
  } catch (err) {
    erreur.textContent = err.message;
    erreur.hidden = false;
  } finally {
    bouton.disabled = false;
    bouton.textContent = 'Se connecter';
  }
});

document.getElementById('deconnexion').addEventListener('click', deconnecter);

function deconnecter() {
  // LE CACHE EST VIDÉ AVANT D'OUBLIER QUI ON ÉTAIT — les clés portent
  // l'identifiant du membre, et `purgerCache()` en a besoin. L'ordre inverse
  // laisserait des montants et des impayés lisibles par la personne suivante
  // sur le même téléphone, ce qui est précisément ce que la déconnexion
  // promet d'empêcher.
  try { purgerCache(); } catch { /* stockage indisponible : rien à purger */ }

  session = { jeton: null, membre: null, groupe: null };
  try { sessionStorage.removeItem('tontine'); } catch { /* sans importance */ }
  document.getElementById('application').hidden = true;
  document.getElementById('ecran-connexion').classList.add('actif');
  document.getElementById('mot-de-passe').value = '';
}

/* ----------------------------------------------------------- navigation --- */

/* Les onglets dépendent des rôles. Un onglet sans habilitation est ABSENT, pas
   grisé : un bouton inactif invite à chercher comment le débloquer, alors que
   son absence dit simplement que ce n'est pas votre rôle. */
function ongletsVisibles() {
  const onglets = [];
  const bureau = aRole('TRESORIER') || aRole('PRESIDENT') || aRole('COMMISSAIRE');

  if (aRole('TRESORIER')) {
    onglets.push({ cle: 'saisie',  nom: 'Saisir' });
    onglets.push({ cle: 'impayes', nom: 'Impayés' });
  }

  onglets.push({ cle: 'accueil', nom: 'Situation' });
  onglets.push({ cle: 'membres', nom: 'Membres' });

  // LES ONGLETS SUIVENT LE MÉCANISME DU GROUPE. Un tour de rôle n'existe qu'en
  // ROSCA, un prêt qu'en ASCA, une aide qu'en MUTUELLE — la base le refuserait
  // autrement (décision 0002). Afficher un onglet « Prêts » à une tontine
  // rotative promettrait une fonction qui n'existe pas pour elle.
  if (session.groupe.type === 'ROSCA') {
    onglets.push({ cle: 'tours', nom: 'Tours' });
  }
  if (session.groupe.type === 'ASCA') {
    onglets.push({ cle: 'prets', nom: 'Prêts' });
  }
  if (session.groupe.type === 'MUTUELLE') {
    onglets.push({ cle: 'aides', nom: 'Aides' });
  }

  // Le rapport d'assemblée est ouvert à TOUS les membres : c'est un document
  // fait pour être lu devant le groupe. Le réserver au bureau reproduirait
  // l'opacité que la plateforme existe pour abolir.
  onglets.push({ cle: 'rapport', nom: 'Rapport' });

  if (bureau) {
    onglets.push({ cle: 'anomalies', nom: 'À vérifier' });
    onglets.push({ cle: 'journal',   nom: 'Opérations' });
  }

  // L'historique est ouvert à TOUS : un membre qui conteste une dispense
  // doit pouvoir lire qui l'a accordée, et pourquoi.
  onglets.push({ cle: 'historique', nom: 'Historique' });

  if (bureau) {
  }

  // Le rapprochement Mobile Money n'a de sens que pour le trésorier, qui seul
  // saisit les versements dont il faut vérifier la trace.
  if (aRole('TRESORIER')) {
    onglets.push({ cle: 'rapprochement', nom: 'Mobile Money' });
  }

  return onglets;
}

function dessinerOnglets() {
  const barre = document.getElementById('onglets');
  const onglets = ongletsVisibles();

  barre.innerHTML = onglets.map((o) =>
    `<button class="onglet${o.cle === ongletCourant ? ' actif' : ''}" data-cle="${o.cle}">${txt(o.nom)}</button>`
  ).join('');

  barre.querySelectorAll('.onglet').forEach((bouton) => {
    bouton.addEventListener('click', () => afficher(bouton.dataset.cle));
  });
}

const ECRANS = {
  accueil:   ecranAccueil,
  saisie:    ecranSaisie,
  impayes:   ecranImpayes,
  membres:   ecranMembres,
  tours:     ecranTours,
  prets:     ecranPrets,
  aides:     ecranAides,
  anomalies: ecranAnomalies,
  journal:   ecranJournal,
  rapport:       ecranRapport,
  rapprochement: ecranRapprochement,
  historique:    ecranHistorique,
};

/* Écrans qui produisent un DOCUMENT — ceux qu'on lit en assemblée ou qu'on
   classe. Imprimer l'écran de saisie n'aurait aucun sens, et un bouton qui
   n'en a pas sur la moitié des écrans cesse d'être lu. */
const ECRANS_IMPRIMABLES = [
  'rapport', 'impayes', 'membres', 'journal',
  'tours', 'prets', 'aides', 'accueil', 'historique',
];

async function afficher(cle) {
  ongletCourant = cle;
  try { sessionStorage.setItem('ecran', cle); } catch { /* sans importance */ }
  dessinerOnglets();

  const contenu = document.getElementById('contenu');
  contenu.innerHTML = '<p class="vide">Chargement…</p>';

  try {
    await ECRANS[cle](contenu);

    if (ECRANS_IMPRIMABLES.includes(cle)) {
      const barre = document.createElement('div');
      barre.className = 'barre-impression';
      barre.innerHTML =
        '<button class="secondaire" id="bouton-imprimer">' +
        'Imprimer ce document</button>';
      contenu.appendChild(barre);
      document.getElementById('bouton-imprimer')
        .addEventListener('click', imprimer);
    }
  } catch (err) {
    contenu.innerHTML = `<div class="carte"><p class="erreur">${txt(err.message)}</p></div>`;
  }
}

/** Initiales d'un nom de groupe, pour la pastille d'en-tête.
    Deux lettres au plus : au-delà, elles deviennent illisibles dans 38 px.
    On ignore les mots-outils, qui n'identifient rien — « Tontine des Femmes de
    Bonabéri » donne « TF », pas « TD ». */
function initiales(nom) {
  const outils = ['de', 'des', 'du', 'la', 'le', 'les', 'd', 'l', 'et', 'aux'];
  const mots = String(nom || '')
    .split(/[\s'’-]+/)
    .filter((m) => m && !outils.includes(m.toLowerCase()));
  return mots.slice(0, 2).map((m) => m[0].toUpperCase()).join('') || '?';
}

function demarrer() {
  document.getElementById('ecran-connexion').classList.remove('actif');
  document.getElementById('application').hidden = false;
  document.getElementById('nom-groupe').textContent = session.groupe.nom;
  document.getElementById('pastille').textContent = initiales(session.groupe.nom);
  document.getElementById('identite').textContent =
    session.membre.nom_complet + ' · ' + session.membre.roles.join(', ').toLowerCase();

  /* L'écran d'arrivée. Par défaut, la trésorière arrive sur la saisie — c'est
     son geste quotidien, et N-USG-04 impose 30 secondes ; un membre arrive sur
     sa situation.

     Si un écran était consulté avant un rechargement, on y revient : perdre sa
     place en rechargeant une page est une petite trahison, surtout sur un
     téléphone qui recharge tout seul en changeant d'application. */
  let arrivee = aRole('TRESORIER') ? 'saisie' : 'accueil';
  try {
    const demande = sessionStorage.getItem('ecran');
    if (demande && ECRANS[demande] &&
        ongletsVisibles().some((o) => o.cle === demande)) {
      arrivee = demande;
    }
  } catch { /* stockage indisponible : on garde le défaut */ }

  afficher(arrivee);
  precharger();
}

/* PRÉCHARGEMENT DES ÉCRANS DE CONSULTATION.

   SANS LUI, LE HORS-LIGNE NE COUVRIRAIT QUE L'ÉCRAN DÉJÀ OUVERT. Un premier
   essai en navigateur ne trouvait qu'une seule entrée archivée : le trésorier
   qui n'avait consulté que l'accueil se retrouvait, en réunion, avec un seul
   écran lisible — et les questions du groupe portent justement sur les impayés
   et les relevés.

   FAIT EN ARRIÈRE-PLAN ET SANS BLOQUER. Chaque écran est demandé une fois,
   `appel()` l'archive au passage, et les échecs sont ignorés : un membre sans
   habilitation reçoit un 403 sur `/impayes`, ce qui est normal et ne doit rien
   interrompre.

   LIMITÉ AUX ÉCRANS QUE L'UTILISATEUR PEUT VOIR. Précharger une route interdite
   remplirait les journaux d'accès de refus qui ressembleraient à des tentatives
   d'intrusion — et brouilleraient le travail du commissaire aux comptes. */
function precharger() {
  if (navigator.onLine === false) return;

  /* LES CHEMINS SONT CEUX QUE LES ÉCRANS DEMANDENT, AU CARACTÈRE PRÈS.

     La clé du cache est le chemin lui-même : précharger `/impayes` quand
     l'écran appelle `/cotisations/impayes` remplirait le cache d'une entrée
     que rien ne relirait jamais, tout en donnant l'illusion que l'écran est
     disponible hors ligne. Vérifié route par route contre les appels réels du
     fichier — deux des cinq premières esquisses étaient fausses. */
  const routes = ['/tableau-de-bord', '/membres'];

  if (aRole('TRESORIER') || aRole('PRESIDENT') || aRole('COMMISSAIRE')) {
    routes.push('/cotisations/impayes', '/rapport-assemblee');
  }
  if (session.groupe.type === 'ROSCA') routes.push('/tours');
  if (session.groupe.type === 'ASCA') routes.push('/prets');
  if (session.groupe.type === 'MUTUELLE') routes.push('/aides');

  // Séquentiel, et non en parallèle : sur une connexion faible — celle des
  // utilisateurs visés — lancer six requêtes d'un coup ralentirait l'écran que
  // la personne est en train de regarder.
  routes.reduce(
    (chaine, route) =>
      chaine.then(() => appel(route).catch(() => undefined)),
    Promise.resolve(),
  );
}

/* ================================================================ ÉCRANS === */

/* -------------------------------------------------------------- accueil --- */

async function ecranAccueil(contenu) {
  const tb = await appel('/tableau-de-bord');

  const recouvrement = tb.taux_recouvrement === null
    ? '—'
    : Number(tb.taux_recouvrement).toLocaleString('fr-FR') + ' %';

  let html = `
    <div class="grille">
      <div class="chiffre">
        <span class="valeur">${francs(tb.tresorerie)}</span>
        <span class="etiquette">en caisse</span>
      </div>
      <div class="chiffre">
        <span class="valeur">${recouvrement}</span>
        <span class="etiquette">des cotisations versées</span>
      </div>
      <div class="chiffre">
        <span class="valeur">${txt(tb.membres_actifs)}</span>
        <span class="etiquette">membres</span>
      </div>
    </div>`;

  if (tb.prochain_beneficiaire) {
    const manque = Number(tb.manque_pour_remise || 0);
    html += `
      <div class="carte">
        <h2>Tour ${txt(tb.tour_rang)} — ${txt(tb.prochain_beneficiaire)}</h2>
        <p class="discret">Remise prévue le ${date(tb.date_remise_prevue)}</p>
        <div class="ligne">
          <span>Déjà collecté</span>
          <span class="montant">${francs(tb.cagnotte_encaissee)}</span>
        </div>
        <div class="ligne">
          <span>Total attendu</span>
          <span class="montant">${francs(tb.cagnotte_attendue)}</span>
        </div>`;

    if (manque > 0) {
      html += `<p class="avertissement">
                 Il manque ${francs(manque)} avant de pouvoir remettre la cagnotte.
               </p>`;
    } else {
      html += `<p class="etat regle">La cagnotte est complète</p>`;
    }
    html += `</div>`;
  }

  // Le membre voit sa propre situation, sans avoir à la chercher.
  const releve = await appel('/cotisations/releve/' + session.membre.id);
  const total = releve
    .filter((v) => !v.annule)
    .reduce((s, v) => s + Number(v.montant), 0);

  html += `
    <div class="carte">
      <h2>Ma situation</h2>
      <div class="ligne">
        <span>J'ai versé</span>
        <span class="montant">${francs(total)}</span>
      </div>
      <p class="discret">${releve.length} versement${releve.length > 1 ? 's' : ''} enregistré${releve.length > 1 ? 's' : ''}</p>
    </div>`;

  contenu.innerHTML = html;
}

/* --------------------------------------------------------------- saisie --- */

/* L'ÉCRAN LE PLUS UTILISÉ, ET LE SEUL DONT LA PERFORMANCE SOIT CHIFFRÉE
   (N-USG-04 : moins de 30 secondes). Toute sa conception en découle :
   le montant est prérempli au reste dû, la date à aujourd'hui, le moyen
   retient le dernier choisi. Dans le cas courant, la trésorière choisit le
   membre et valide — deux gestes. */

let dernierMoyen = 'ESPECES';

async function ecranSaisie(contenu) {
  const impayes = await appel('/cotisations/impayes');
  const aSaisir = impayes.filter((i) => i.statut !== 'DISPENSEE');

  if (aSaisir.length === 0) {
    contenu.innerHTML = `
      <div class="carte">
        <div class="vide">
          <p><strong>Aucune cotisation en attente.</strong></p>
          <p class="discret">Toutes les échéances sont réglées ou dispensées.</p>
        </div>
      </div>`;
    return;
  }

  const options = aSaisir.map((i, index) =>
    `<option value="${index}">${txt(i.nom_complet)} — ${francs(i.reste_du)} dus</option>`
  ).join('');

  contenu.innerHTML = `
    <div class="formulaire">
      <h2>Enregistrer un versement</h2>
      <p class="discret">
        Le versement a déjà été reçu — en espèces ou par Mobile Money.
        Il est ici <em>inscrit au registre</em>.
      </p>

      <label for="choix-membre">Membre</label>
      <select id="choix-membre">${options}</select>

      <div class="rappel" id="rappel"></div>

      <label for="montant">Montant reçu</label>
      <input id="montant" type="number" inputmode="numeric" min="1" step="1" required>

      <div class="duo">
        <div>
          <label for="date-versement">Reçu le</label>
          <input id="date-versement" type="date" value="${aujourdhui()}" max="${aujourdhui()}" required>
        </div>
        <div>
          <label for="moyen">Moyen</label>
          <select id="moyen">
            <option value="ESPECES">Espèces</option>
            <option value="MOBILE_MONEY">Mobile Money</option>
            <option value="VIREMENT">Virement</option>
            <option value="COMPENSATION">Compensation</option>
          </select>
        </div>
      </div>

      <button class="principal" id="valider">Enregistrer le versement</button>
    </div>`;

  const choix    = document.getElementById('choix-membre');
  const montant  = document.getElementById('montant');
  const moyen    = document.getElementById('moyen');
  const rappel   = document.getElementById('rappel');
  const valider  = document.getElementById('valider');

  moyen.value = dernierMoyen;

  function rafraichir() {
    const i = aSaisir[Number(choix.value)];
    const deja = Number(i.montant_regle);

    rappel.innerHTML = `
      <div class="ligne"><span>Échéance du</span><span>${date(i.date_echeance)}</span></div>
      <div class="ligne"><span>Attendu</span><span class="montant">${francs(i.montant_attendu)}</span></div>
      ${deja > 0 ? `<div class="ligne"><span>Déjà versé</span><span class="montant">${francs(deja)}</span></div>` : ''}
      <div class="ligne"><span><strong>Reste dû</strong></span><span class="montant">${francs(i.reste_du)}</span></div>`;

    // Prérempli au reste dû : le cas de loin le plus fréquent.
    montant.value = i.reste_du;
    montant.max = i.reste_du;
  }

  choix.addEventListener('change', rafraichir);
  rafraichir();

  valider.addEventListener('click', async () => {
    const i = aSaisir[Number(choix.value)];
    valider.disabled = true;
    valider.textContent = 'Enregistrement…';

    try {
      const resultat = await appel('/cotisations', {
        method: 'POST',
        body: JSON.stringify({
          echeance_id: i.echeance_id,
          montant: Number(montant.value),
          date_versement: document.getElementById('date-versement').value,
          moyen: moyen.value,
        }),
      });

      dernierMoyen = moyen.value;

      const reste = Number(resultat.reliquat);
      message(
        reste > 0
          ? `Versement enregistré. Il reste ${francs(reste)} à verser.`
          : `Versement enregistré. ${txt(i.nom_complet)} est à jour.`,
        'succes',
      );

      afficher('saisie');
    } catch (err) {
      message(err.message, 'echec');
      valider.disabled = false;
      valider.textContent = 'Enregistrer le versement';
    }
  });
}

/* -------------------------------------------------------------- impayés --- */

async function ecranImpayes(contenu) {
  const impayes = await appel('/cotisations/impayes');

  if (impayes.length === 0) {
    contenu.innerHTML = `
      <div class="carte"><div class="vide">
        <p><strong>Aucun impayé.</strong></p>
        <p class="discret">Toutes les échéances sont réglées.</p>
      </div></div>`;
    return;
  }

  const dus = impayes.filter((i) => i.statut !== 'DISPENSEE');
  const total = dus.reduce((s, i) => s + Number(i.reste_du), 0);

  const lignes = impayes.map((i) => {
    // Une dispense n'est PAS un impayé — mais la masquer laisserait croire à
    // un oubli. Elle figure donc dans la liste, avec son motif.
    if (i.statut === 'DISPENSEE') {
      return `
        <div class="ligne">
          <div>
            <span class="intitule">${txt(i.nom_complet)}</span>
            <span class="detail">Dispensée — ${txt(i.motif_dispense)}</span>
          </div>
          <span class="etat regle">dispensée</span>
        </div>`;
    }

    const retard = Number(i.jours_retard);
    const detail = i.statut === 'PARTIELLE'
      ? `A versé ${francs(i.montant_regle)} sur ${francs(i.montant_attendu)}`
      : `Échéance du ${dateCourte(i.date_echeance)}`;

    return `
      <div class="ligne">
        <div>
          <span class="intitule">${txt(i.nom_complet)}</span>
          <span class="detail">${detail}${retard > 0 ? ` · ${retard} jour${retard > 1 ? 's' : ''} de retard` : ''}</span>
        </div>
        <span class="montant">${francs(i.reste_du)}</span>
      </div>`;
  }).join('');

  contenu.innerHTML = `
    <div class="carte">
      <h2>Cotisations en attente</h2>
      <p class="discret">
        ${dus.length} membre${dus.length > 1 ? 's' : ''} — ${francs(total)} attendus
      </p>
      ${lignes}
    </div>`;
}

/* -------------------------------------------------------------- membres --- */

async function ecranMembres(contenu) {
  const membres = await appel('/membres');

  const lignes = membres.map((m) => {
    const reste = Number(m.reste_du);
    return `
      <div class="ligne">
        <div>
          <span class="intitule">${txt(m.nom_complet)}</span>
          <span class="detail">
            A versé ${francs(m.total_verse)}
            ${m.roles.filter((r) => r !== 'MEMBRE').length
              ? ' · ' + txt(m.roles.filter((r) => r !== 'MEMBRE').join(', ').toLowerCase())
              : ''}
          </span>
        </div>
        ${reste > 0
          ? `<span class="etat attente">${francs(reste)} dus</span>`
          : `<span class="etat regle">à jour</span>`}
      </div>`;
  }).join('');

  contenu.innerHTML = `
    <div class="carte">
      <h2>Membres</h2>
      <p class="discret">${membres.length} membres actifs</p>
      ${lignes}
    </div>`;
}

/* ---------------------------------------------------------------- tours --- */

async function ecranTours(contenu) {
  const tours = await appel('/tours');

  const lignes = tours.map((t) => {
    if (t.remis) {
      return `
        <div class="ligne">
          <div>
            <span class="intitule">Tour ${txt(t.rang)} — ${txt(t.beneficiaire)}</span>
            <span class="detail">Remis le ${date(t.date_remise_reelle)}</span>
          </div>
          <span class="montant">${francs(t.montant_cagnotte)}</span>
        </div>`;
    }

    const manque = Number(t.manque);
    return `
      <div class="ligne">
        <div>
          <span class="intitule">Tour ${txt(t.rang)} — ${txt(t.beneficiaire)}</span>
          <span class="detail">
            Prévu le ${dateCourte(t.date_remise_prevue)} ·
            ${francs(t.cagnotte_encaissee)} collectés
          </span>
        </div>
        ${manque > 0
          ? `<span class="etat attente">${francs(manque)} manquants</span>`
          : `<span class="etat regle">complète</span>`}
      </div>`;
  }).join('');

  const courant = tours.find((t) => !t.remis);
  let remise = '';

  // Le bouton de remise n'apparaît QUE si la cagnotte est complète. Ni grisé,
  // ni affichant une erreur au clic : absent, avec la raison en clair. C'est
  // l'écran §6 de la conception.
  if (courant && aRole('TRESORIER')) {
    const manque = Number(courant.manque);

    remise = manque > 0
      ? `<div class="carte">
           <h2>Remettre la cagnotte du tour ${txt(courant.rang)}</h2>
           <p class="avertissement">
             La remise est impossible tant que les cotisations ne sont pas
             encaissées. Il manque ${francs(manque)}.
           </p>
         </div>`
      : `<div class="carte">
           <h2>Remettre la cagnotte du tour ${txt(courant.rang)}</h2>
           <p>Bénéficiaire : <strong>${txt(courant.beneficiaire)}</strong></p>
           <div class="ligne">
             <span>Montant à remettre</span>
             <span class="montant">${francs(courant.cagnotte_encaissee)}</span>
           </div>
           <button class="principal" id="remettre"
                   data-tour="${txt(courant.tour_id)}">
             Remettre ${francs(courant.cagnotte_encaissee)} à ${txt(courant.beneficiaire)}
           </button>
         </div>`;
  }

  contenu.innerHTML = `
    ${remise}
    <div class="carte">
      <h2>Ordre de passage</h2>
      <p class="discret">Fixé à l'avance par le groupe</p>
      ${lignes}
    </div>`;

  const bouton = document.getElementById('remettre');
  if (bouton) {
    bouton.addEventListener('click', async () => {
      bouton.disabled = true;
      bouton.textContent = 'Enregistrement…';
      try {
        const r = await appel('/tours/' + bouton.dataset.tour + '/remise', {
          method: 'POST',
        });
        message(
          `${francs(r.montant_remis)} remis à ${r.beneficiaire}.` +
          (r.cycle_cloture ? ' Le cycle est terminé.' : ''),
          'succes',
        );
        afficher('tours');
      } catch (err) {
        message(err.message, 'echec');
        bouton.disabled = false;
      }
    });
  }
}

/* ---------------------------------------------------------------- prêts --- */

/* Spécialisation ASCA. L'écran montre l'encours, l'échéancier et — pour le
   président — les demandes en attente de décision. */

async function ecranPrets(contenu) {
  const prets = await appel('/prets');

  const enAttente = prets.filter((p) => p.statut === 'DEMANDE');
  const enCours = prets.filter((p) =>
    ['EN_REMBOURSEMENT', 'EN_RETARD', 'REECHELONNE'].includes(p.statut));
  const clos = prets.filter((p) => ['SOLDE', 'REFUSE'].includes(p.statut));

  let html = '';

  // L'avoir disponible commande ce que la caisse peut prêter (R-06). L'afficher
  // avant les demandes évite d'approuver un prêt que la caisse ne peut honorer.
  if (aRole('PRESIDENT') || aRole('TRESORIER') || aRole('COMMISSAIRE')) {
    try {
      const avoir = await appel('/prets/avoir-disponible');
      html += `
        <div class="grille">
          <div class="chiffre">
            <span class="valeur">${francs(avoir.avoir)}</span>
            <span class="etiquette">que la caisse peut prêter</span>
          </div>
          <div class="chiffre">
            <span class="valeur">${enCours.length}</span>
            <span class="etiquette">prêt${enCours.length > 1 ? 's' : ''} en cours</span>
          </div>
        </div>`;
    } catch {
      // Habilitation insuffisante : l'écran reste utile sans ce bloc.
    }
  }

  if (enAttente.length > 0) {
    html += `<div class="carte"><h2>Demandes à étudier</h2>` +
      enAttente.map((p) => `
        <div class="ligne">
          <div>
            <span class="intitule">${txt(p.emprunteur)} — ${francs(p.montant_demande)}</span>
            <span class="detail">${txt(p.motif_demande)}</span>
          </div>
          ${aRole('PRESIDENT')
            ? `<button class="secondaire" data-approuver="${txt(p.id)}"
                       data-montant="${txt(p.montant_demande)}"
                       data-nom="${txt(p.emprunteur)}">Approuver</button>`
            : `<span class="etat attente">en attente</span>`}
        </div>`).join('') + `</div>`;
  }

  if (enCours.length > 0) {
    html += `<div class="carte"><h2>Prêts en cours</h2>` +
      enCours.map((p) => {
        const retard = Number(p.echeances_en_retard) > 0;
        return `
          <div class="ligne">
            <div>
              <span class="intitule">${txt(p.emprunteur)}</span>
              <span class="detail">
                Reste à rembourser ${francs(p.capital_restant_du)}
                sur ${francs(p.montant_accorde)}
              </span>
            </div>
            ${retard
              ? `<span class="etat refus">${txt(p.echeances_en_retard)} en retard</span>`
              : `<span class="etat regle">à jour</span>`}
          </div>`;
      }).join('') + `</div>`;
  }

  if (clos.length > 0) {
    html += `<div class="carte"><h2>Prêts clos</h2>` +
      clos.map((p) => `
        <div class="ligne">
          <div>
            <span class="intitule">${txt(p.emprunteur)}</span>
            <span class="detail">
              ${p.statut === 'SOLDE'
                ? 'Remboursé intégralement'
                : 'Refusé — ' + txt(p.motif_decision || '')}
            </span>
          </div>
          <span class="etat ${p.statut === 'SOLDE' ? 'regle' : 'refus'}">
            ${p.statut === 'SOLDE' ? 'soldé' : 'refusé'}
          </span>
        </div>`).join('') + `</div>`;
  }

  if (prets.length === 0) {
    html = `<div class="carte"><div class="vide">
              <p><strong>Aucun prêt.</strong></p>
              <p class="discret">La caisse n'a encore consenti aucun prêt.</p>
            </div></div>`;
  }

  contenu.innerHTML = html;

  contenu.querySelectorAll('[data-approuver]').forEach((bouton) => {
    bouton.addEventListener('click', async () => {
      const montant = prompt(
        `Montant à accorder à ${bouton.dataset.nom} ?`,
        bouton.dataset.montant,
      );
      if (montant === null) return;

      bouton.disabled = true;
      try {
        const r = await appel('/prets/' + bouton.dataset.approuver + '/approbation', {
          method: 'POST',
          body: JSON.stringify({ montant: Number(montant) }),
        });
        message(
          `${francs(r.montant_accorde)} accordés — ${r.echeances} échéances.`,
          'succes',
        );
        afficher('prets');
      } catch (err) {
        message(err.message, 'echec');
        bouton.disabled = false;
      }
    });
  });
}

/* ---------------------------------------------------------------- aides --- */

/* Spécialisation MUTUELLE. Une aide n'ouvre AUCUNE créance : le vocabulaire de
   l'écran ne doit jamais laisser croire qu'elle sera remboursée. */

async function ecranAides(contenu) {
  const aides = await appel('/aides');

  const aDecider = aides.filter((a) => a.statut === 'DEMANDEE');
  const aVerser  = aides.filter((a) => a.statut === 'APPROUVEE');
  const closes   = aides.filter((a) => ['VERSEE', 'REFUSEE'].includes(a.statut));

  let html = '';

  if (aDecider.length > 0) {
    html += `<div class="carte"><h2>Demandes à étudier</h2>` +
      aDecider.map((a) => `
        <div class="ligne">
          <div>
            <span class="intitule">${txt(a.beneficiaire)} — ${francs(a.montant_demande)}</span>
            <span class="detail">${txt(a.motif)}</span>
          </div>
          ${aRole('PRESIDENT')
            ? `<button class="secondaire" data-approuver-aide="${txt(a.id)}"
                       data-montant="${txt(a.montant_demande)}"
                       data-nom="${txt(a.beneficiaire)}">Décider</button>`
            : `<span class="etat attente">en attente</span>`}
        </div>`).join('') + `</div>`;
  }

  if (aVerser.length > 0) {
    html += `<div class="carte"><h2>Aides accordées, à remettre</h2>` +
      aVerser.map((a) => `
        <div class="ligne">
          <div>
            <span class="intitule">${txt(a.beneficiaire)} — ${francs(a.montant_accorde)}</span>
            <span class="detail">${txt(a.motif)}</span>
          </div>
          ${aRole('TRESORIER')
            ? `<button class="secondaire" data-verser="${txt(a.id)}"
                       data-nom="${txt(a.beneficiaire)}"
                       data-montant="${txt(a.montant_accorde)}">Remettre</button>`
            : `<span class="etat attente">à remettre</span>`}
        </div>`).join('') + `</div>`;
  }

  if (closes.length > 0) {
    html += `<div class="carte"><h2>Aides passées</h2>` +
      closes.map((a) => `
        <div class="ligne">
          <div>
            <span class="intitule">${txt(a.beneficiaire)}</span>
            <span class="detail">
              ${txt(a.motif)}${a.date_versement ? ' · remise le ' + date(a.date_versement) : ''}
            </span>
          </div>
          ${a.statut === 'VERSEE'
            ? `<span class="montant">${francs(a.montant_accorde)}</span>`
            : `<span class="etat refus">refusée</span>`}
        </div>`).join('') + `</div>`;
  }

  if (aides.length === 0) {
    html = `<div class="carte"><div class="vide">
              <p><strong>Aucune demande d'aide.</strong></p>
              <p class="discret">Le fonds n'a encore été sollicité par personne.</p>
            </div></div>`;
  }

  contenu.innerHTML = html;

  contenu.querySelectorAll('[data-approuver-aide]').forEach((bouton) => {
    bouton.addEventListener('click', async () => {
      // Le montant accordé peut être INFÉRIEUR au montant demandé : le groupe
      // arbitre selon l'état du fonds. C'est une décision, pas un droit.
      const montant = prompt(
        `Montant accordé à ${bouton.dataset.nom} ?`,
        bouton.dataset.montant,
      );
      if (montant === null) return;

      bouton.disabled = true;
      try {
        await appel('/aides/' + bouton.dataset.approuverAide + '/approbation', {
          method: 'POST',
          body: JSON.stringify({ montant: Number(montant) }),
        });
        message('Aide accordée. Elle reste à remettre au bénéficiaire.', 'succes');
        afficher('aides');
      } catch (err) {
        message(err.message, 'echec');
        bouton.disabled = false;
      }
    });
  });

  contenu.querySelectorAll('[data-verser]').forEach((bouton) => {
    bouton.addEventListener('click', async () => {
      bouton.disabled = true;
      try {
        const r = await appel('/aides/' + bouton.dataset.verser + '/versement', {
          method: 'POST',
        });
        message(`${francs(r.montant_verse)} remis à ${r.beneficiaire}.`, 'succes');
        afficher('aides');
      } catch (err) {
        message(err.message, 'echec');
        bouton.disabled = false;
      }
    });
  });
}

/* ------------------------------------------------------------ anomalies --- */

/* L'ÉCRAN S'APPELLE « À VÉRIFIER », PAS « ANOMALIES » — encore moins
   « ALERTES ». Une tontine repose sur la confiance ; un outil qui désignerait
   un coupable détruirait ce qu'il prétend protéger. Chaque libellé décrit un
   constat, jamais une intention. */

async function ecranAnomalies(contenu) {
  const ouvertes = await appel('/anomalies');

  const critiques = ouvertes.filter((a) => a.gravite === 'CRITIQUE');
  const autres    = ouvertes.filter((a) => a.gravite !== 'CRITIQUE');

  let html = `
    <div class="carte">
      <h2>À vérifier</h2>
      <p class="discret">
        Des écarts constatés automatiquement. Chacun peut avoir une explication
        simple — un versement saisi en retard, une dispense accordée.
      </p>
      <button class="secondaire" id="balayer">Relancer la vérification</button>
    </div>`;

  const carte = (a) => `
    <div class="ligne">
      <div>
        <span class="intitule">${txt(a.description)}</span>
        <span class="detail">Constaté le ${date(a.detectee_le)}</span>
      </div>
      <button class="secondaire" data-lever="${txt(a.id)}">Justifier</button>
    </div>`;

  if (critiques.length > 0) {
    html += `<div class="carte">
               <h2>À vérifier en priorité</h2>
               ${critiques.map(carte).join('')}
             </div>`;
  }

  if (autres.length > 0) {
    html += `<div class="carte"><h2>À examiner</h2>${autres.map(carte).join('')}</div>`;
  }

  if (ouvertes.length === 0) {
    html += `<div class="carte"><div class="vide">
               <p><strong>Rien à vérifier.</strong></p>
               <p class="discret">Les comptes du groupe sont cohérents.</p>
             </div></div>`;
  }

  // Les anomalies levées restent consultables : la levée fait partie de la
  // piste d'audit, elle n'efface rien.
  const levees = await appel('/anomalies/levees');
  if (levees.length > 0) {
    html += `<div class="carte">
      <h2>Déjà justifiées</h2>
      <p class="discret">
        Ces écarts ont été expliqués. Ils restent au dossier : savoir qu'un
        écart a été constaté puis justifié vaut souvent plus que l'écart.
      </p>` +
      levees.map((a) => `
        <div class="ligne">
          <div>
            <span class="intitule">${txt(a.description)}</span>
            <span class="detail">
              ${txt(a.motif_levee)} — ${txt(a.levee_par || '')}, le ${date(a.levee_le)}
            </span>
          </div>
        </div>`).join('') + `</div>`;
  }

  contenu.innerHTML = html;

  document.getElementById('balayer').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Vérification…';
    try {
      const r = await appel('/anomalies/balayage', { method: 'POST' });
      const total = Object.values(r).reduce((s, n) => s + Number(n), 0);
      message(
        total === 0
          ? 'Vérification terminée : rien à signaler.'
          : `Vérification terminée : ${total} point${total > 1 ? 's' : ''} à examiner.`,
        'succes',
      );
      afficher('anomalies');
    } catch (err) {
      message(err.message, 'echec');
      e.target.disabled = false;
      e.target.textContent = 'Relancer la vérification';
    }
  });

  contenu.querySelectorAll('[data-lever]').forEach((bouton) => {
    bouton.addEventListener('click', async () => {
      // Le motif est obligatoire et restera au dossier (F-ANO-08). L'invite le
      // dit, pour qu'on ne découvre pas après coup que « vu » était insuffisant.
      const motif = prompt(
        'Pourquoi cet écart s\'explique-t-il ?\n\n' +
        'Votre explication restera au dossier et doit rester compréhensible ' +
        'dans plusieurs mois (20 caractères au moins).',
      );
      if (motif === null) return;

      bouton.disabled = true;
      try {
        await appel('/anomalies/' + bouton.dataset.lever + '/levee', {
          method: 'POST',
          body: JSON.stringify({ motif }),
        });
        message('Écart justifié. Il reste consultable au dossier.', 'succes');
        afficher('anomalies');
      } catch (err) {
        message(err.message, 'echec');
        bouton.disabled = false;
      }
    });
  });
}

/* -------------------------------------------------------------- rapport --- */

/* F-RAP-05 — LE RAPPORT D'ASSEMBLÉE.
   Un document qu'une personne lit à voix haute devant le groupe, et que chacun
   doit pouvoir contester chiffre en main. Il dit aussi ce qui ne va pas : taire
   les anomalies ouvertes reviendrait à rassurer plutôt qu'à rendre compte. */

/** Valeur d'une ligne de rapport, formatée pour la lecture à voix haute.
    On privilégie le champ numérique `montant` : analyser la chaîne `valeur`
    casserait dès qu'un libellé ou une devise change. */
function valeurRapport(ligne) {
  const brut = String(ligne.valeur ?? '');

  // Une valeur non monétaire — un compte, un taux, un état — s'affiche telle
  // quelle : « 12 membres » n'a pas à devenir « 12 F ».
  if (ligne.montant === null || ligne.montant === undefined) return txt(brut);

  // Le montant n'accompagne une somme que si la valeur porte la devise ; les
  // décomptes portent le même champ sans être de l'argent.
  const devise = brut.match(/[A-Z]{3}$/);
  if (!devise) return txt(brut);

  return txt(Number(ligne.montant).toLocaleString('fr-FR')
    .replace(/\u202f|\s/g, '\u00a0') + '\u00a0' + devise[0]);
}

async function ecranRapport(contenu) {
  const lignes = await appel('/rapport-assemblee');

  // Regroupement par rubrique, dans l'ordre où le serveur les renvoie : cet
  // ordre est celui de la lecture en assemblée, il ne doit pas être trié.
  const rubriques = [];
  for (const l of lignes) {
    let groupe = rubriques.find((r) => r.nom === l.rubrique);
    if (!groupe) {
      groupe = { nom: l.rubrique, lignes: [] };
      rubriques.push(groupe);
    }
    groupe.lignes.push(l);
  }

  const cartes = rubriques.map((r) => `
    <div class="carte">
      <h2>${txt(r.nom)}</h2>
      ${r.lignes.map((l) => `
        <div class="ligne">
          <span>${txt(l.intitule)}</span>
          <span class="montant">${valeurRapport(l)}</span>
        </div>`).join('')}
    </div>`).join('');

  contenu.innerHTML = `
    <div class="carte">
      <h2>Rapport d'assemblée</h2>
      <p class="discret">
        Tous les chiffres sont recalculés à partir des opérations enregistrées.
        Chacun peut les vérifier pièce en main.
      </p>
      <button class="secondaire" id="export-rapport">Enregistrer en tableur</button>
    </div>
    ${cartes}`;

  document.getElementById('export-rapport').addEventListener('click', () => {
    telecharger('/exports/rapport.csv', 'rapport-assemblee.csv');
  });
}

/* Téléchargement d'un export. Le jeton voyageant dans un en-tête, un simple
   lien ne suffit pas : on récupère le contenu puis on le remet au navigateur. */
async function telecharger(chemin, nom) {
  try {
    const reponse = await fetch(API + chemin, {
      headers: { Authorization: 'Bearer ' + session.jeton },
    });
    if (!reponse.ok) throw new Error('Export refusé');

    const texte = await reponse.text();
    const lien = document.createElement('a');
    lien.href = URL.createObjectURL(
      new Blob([texte], { type: 'text/csv;charset=utf-8' }));
    lien.download = nom;
    lien.click();
    URL.revokeObjectURL(lien.href);
    message('Fichier enregistré.', 'succes');
  } catch (err) {
    message(err.message, 'echec');
  }
}

/* -------------------------------------------------- rapprochement MM --- */

/* F-TRX-06 — LE RAPPROCHEMENT NE CORRIGE RIEN.
   Il compare le relevé de l'opérateur au registre et signale les écarts dans
   les deux sens. Importer automatiquement les lignes reviendrait à laisser un
   opérateur écrire dans les comptes du groupe. */

async function ecranRapprochement(contenu) {
  const releves = await appel('/releves');

  if (releves.length === 0) {
    contenu.innerHTML = `
      <div class="carte"><div class="vide">
        <p><strong>Aucun relevé importé.</strong></p>
        <p class="discret">
          Importez un relevé Mobile Money pour vérifier qu'il correspond aux
          versements enregistrés.
        </p>
      </div></div>`;
    return;
  }

  const dernier = releves[0];
  const r = await appel('/releves/' + dernier.id + '/rapprochement');

  const ecarts = r.lignes.filter((l) => l.statut !== 'RAPPROCHE');

  let html = `
    <div class="carte">
      <h2>${txt(dernier.operateur)}</h2>
      <p class="discret">
        Du ${date(dernier.periode_debut)} au ${date(dernier.periode_fin)} ·
        ${txt(dernier.lignes)} ligne(s) importée(s)
      </p>
    </div>
    <div class="grille">
      <div class="chiffre">
        <span class="valeur">${txt(r.synthese.rapproches)}</span>
        <span class="etiquette">versements retrouvés</span>
      </div>
      <div class="chiffre">
        <span class="valeur">${txt(r.synthese.absents_du_registre)}</span>
        <span class="etiquette">reçus mais non saisis</span>
      </div>
      <div class="chiffre">
        <span class="valeur">${txt(r.synthese.absents_du_releve)}</span>
        <span class="etiquette">saisis mais introuvables</span>
      </div>
    </div>`;

  if (ecarts.length > 0) {
    html += `<div class="carte">
      <h2>À vérifier</h2>
      <p class="discret">
        Ces écarts sont signalés, non corrigés. C'est à vous de décider ce que
        chacun appelle.
      </p>` +
      ecarts.map((l) => `
        <div class="ligne">
          <div>
            <span class="intitule">
              ${l.statut === 'ABSENT_DU_REGISTRE'
                ? 'Reçu mais non enregistré'
                : 'Enregistré mais absent du relevé'}
            </span>
            <span class="detail">
              ${txt(l.reference)}${l.membre ? ' · ' + txt(l.membre) : ''}
              · ${date(l.date_operation)}
            </span>
          </div>
          <span class="montant">
            ${francs(l.montant_releve || l.montant_registre)}
          </span>
        </div>`).join('') + `</div>`;
  } else {
    html += `<div class="carte"><div class="vide">
               <p><strong>Tout concorde.</strong></p>
               <p class="discret">
                 Chaque versement du relevé correspond à un versement enregistré.
               </p>
             </div></div>`;
  }

  contenu.innerHTML = html;
}

/* ------------------------------------------------------- impression --- */

/* TITRES DES DOCUMENTS, par écran. Un document imprimé doit se nommer : une
   feuille intitulée « Tontine » ne dit pas si elle porte les impayés ou le
   rapport d'assemblée. */
const TITRES_IMPRESSION = {
  accueil:       'Situation du groupe',
  impayes:       'État des cotisations en attente',
  membres:       'Liste des membres et de leur situation',
  tours:         'Ordre de passage et remises',
  prets:         'État des prêts',
  aides:         'État des aides',
  rapport:       "Rapport d'assemblée générale",
  anomalies:     'Points à vérifier',
  rapprochement: 'Rapprochement Mobile Money',
  journal:       'Journal des opérations',
  historique:    'Historique des décisions du groupe',
  saisie:        'Saisie de versement',
};

/* Empreinte courte du document : quatre caractères dérivés de l'horodatage et
   de l'écran. Deux impressions du même écran à deux moments différents portent
   des empreintes différentes — c'est ce qui permet, en cas de désaccord, de
   savoir laquelle des deux feuilles est la plus récente. */
function empreinte(graine) {
  let h = 0;
  for (const c of graine) {
    h = ((h << 5) - h + c.charCodeAt(0)) | 0;
  }
  return Math.abs(h).toString(36).toUpperCase().padStart(4, '0').slice(0, 4);
}

/** Prépare l'en-tête et le pied du document, juste avant l'impression. */
function preparerImpression() {
  const maintenant = new Date();
  const ecran = ongletCourant || 'accueil';

  document.getElementById('impression-cachet').textContent =
    initiales(session.groupe.nom);

  document.getElementById('impression-titre').textContent =
    TITRES_IMPRESSION[ecran] || 'Registre du groupe';

  document.getElementById('impression-groupe').textContent = session.groupe.nom;

  const mecanisme = {
    ROSCA:    'Tontine rotative',
    ASCA:     "Caisse d'épargne cumulative",
    MUTUELLE: 'Association mutualiste',
  }[session.groupe.type] || session.groupe.type;

  document.getElementById('impression-contexte').textContent =
    mecanisme + ' · Document établi par ' + session.membre.nom_complet;

  document.getElementById('impression-arrete').innerHTML =
    'Arrêté au<strong>' + txt(date(maintenant.toISOString())) + '</strong>' +
    maintenant.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  const marque = maintenant.toISOString();
  document.getElementById('impression-empreinte').textContent =
    'Réf. ' + empreinte(marque + ecran) + ' · ' + marque.slice(0, 16).replace('T', ' ');

  document.getElementById('impression-edite').textContent =
    'Édité depuis le registre du groupe';

  /* LES VISAS N'APPARAISSENT QUE SUR LES DOCUMENTS QUI ENGAGENT.
     Une liste de membres ne se signe pas ; un rapport d'assemblée ou un état
     de caisse, si. Faire signer n'importe quoi banaliserait la signature. */
  const aVisa = ['rapport', 'impayes', 'journal', 'prets', 'aides'];
  document.getElementById('impression-visas')
    .classList.toggle('imprime', aVisa.includes(ecran));
}

/* `beforeprint` couvre Ctrl+P, le menu du navigateur et le bouton : un seul
   point d'entrée, donc aucun chemin où l'en-tête serait oublié. */
window.addEventListener('beforeprint', () => {
  if (session.jeton) preparerImpression();
});

/* Safari ancien n'émet pas `beforeprint` : on double par la media query. */
if (window.matchMedia) {
  const impression = window.matchMedia('print');
  const reagir = (e) => { if (e.matches && session.jeton) preparerImpression(); };
  if (impression.addEventListener) impression.addEventListener('change', reagir);
}

function imprimer() {
  preparerImpression();
  window.print();
}

/* ----------------------------------------------------------- historique --- */

/* LA TRAÇABILITÉ, RENDUE LISIBLE.
   Le journal des opérations montre les mouvements d'argent ; celui-ci montre
   les DÉCISIONS — une dispense accordée, un prêt refusé, un écart justifié.
   Ce sont celles qu'on conteste en assemblée, et qui n'apparaissaient nulle
   part. Ouvert à tout membre : le réserver au bureau reproduirait l'opacité
   que la plateforme existe pour abolir. */

let filtreHistorique = null;

async function ecranHistorique(contenu) {
  const [lignes, synthese] = await Promise.all([
    appel('/historique?limite=150' +
          (filtreHistorique ? '&categorie=' + encodeURIComponent(filtreHistorique) : '')),
    appel('/historique/synthese'),
  ]);

  const total = synthese.reduce((s, c) => s + Number(c.operations), 0);

  let html = `
    <div class="carte">
      <h2>Historique des décisions</h2>
      <p class="discret">
        Qui a fait quoi, et quand. ${total} opération${total > 1 ? 's' : ''}
        consignée${total > 1 ? 's' : ''} — rien n'est jamais effacé.
      </p>
      <div class="filtres">
        <button class="puce${!filtreHistorique ? ' active' : ''}"
                data-filtre="">Tout</button>
        ${synthese.map((c) => `
          <button class="puce${filtreHistorique === c.categorie ? ' active' : ''}"
                  data-filtre="${txt(c.categorie)}">
            ${txt(c.categorie)} · ${txt(c.operations)}
          </button>`).join('')}
      </div>
    </div>`;

  if (lignes.length === 0) {
    html += `<div class="carte"><div class="vide">
               <p><strong>Aucune opération.</strong></p>
               <p class="discret">
                 Les décisions du groupe apparaîtront ici au fur et à mesure.
               </p>
             </div></div>`;
  } else {
    // Regroupement par jour : une liste de 150 lignes sans repère temporel est
    // illisible, et c'est par date qu'on cherche en assemblée.
    const jours = [];
    for (const l of lignes) {
      const jour = date(l.horodatage);
      let groupe = jours.find((j) => j.jour === jour);
      if (!groupe) { groupe = { jour, lignes: [] }; jours.push(groupe); }
      groupe.lignes.push(l);
    }

    html += jours.map((j) => `
      <div class="carte">
        <h2>${txt(j.jour)}</h2>
        ${j.lignes.map((l) => `
          <div class="ligne">
            <div>
              <span class="intitule">${txt(l.libelle)}</span>
              <span class="detail">
                ${heure(l.horodatage)} · par ${txt(l.auteur)}${
                  l.motif ? ' · « ' + txt(l.motif) + ' »' : ''}
              </span>
            </div>
            <span class="etat ${couleurCategorie(l.categorie)}">
              ${txt(l.categorie)}
            </span>
          </div>`).join('')}
      </div>`).join('');
  }

  contenu.innerHTML = html;

  contenu.querySelectorAll('[data-filtre]').forEach((bouton) => {
    bouton.addEventListener('click', () => {
      filtreHistorique = bouton.dataset.filtre || null;
      afficher('historique');
    });
  });
}

function heure(valeur) {
  const d = new Date(valeur);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/* La couleur porte le registre de la décision : ce qui touche à l'argent, ce
   qui relève du contrôle, et le reste. Trois teintes, pas une par catégorie —
   au-delà, la couleur cesse d'informer. */
function couleurCategorie(categorie) {
  if (categorie === 'Contrôle') return 'attente';
  if (categorie === 'Argent' || categorie === 'Prêts') return 'regle';
  return '';
}

/* -------------------------------------------------------------- journal --- */

/* Réservé au bureau et au commissaire. Un membre lit son relevé en langage
   courant, jamais le mécanisme comptable (N-USG-05). Le mot « écriture »
   n'apparaît pas : on parle d'« opérations ». */

async function ecranJournal(contenu) {
  const operations = await appel('/journal?limite=50');

  const lignes = operations.map((o) => `
    <div class="ligne${o.est_correction ? ' annule' : ''}">
      <div>
        <span class="intitule">${txt(o.libelle)}</span>
        <span class="detail">
          ${date(o.date_operation)} · saisi par ${txt(o.saisi_par)}
          ${o.motif_correction ? ' · ' + txt(o.motif_correction) : ''}
        </span>
      </div>
      <span class="montant">${francs(o.montant)}</span>
    </div>`).join('');

  contenu.innerHTML = `
    <div class="carte">
      <h2>Opérations</h2>
      <p class="discret">
        Les ${operations.length} dernières opérations du groupe.
        Rien n'est jamais effacé : une annulation reste visible, barrée.
      </p>
      ${lignes || '<div class="vide">Aucune opération.</div>'}
    </div>`;
}

/* ------------------------------------------------------------ démarrage --- */

/* Reprise d'une session après rechargement de page.

   UN JETON REFUSÉ ET UNE ABSENCE DE RÉSEAU NE SE TRAITENT PAS PAREIL, et les
   confondre rendait la consultation hors ligne inopérante dans le seul cas qui
   compte.

   La version précédente faisait `.catch(() => deconnecter())` sur la
   vérification du jeton. Hors ligne, cet appel échoue — donc l'application
   déconnectait l'utilisateur et purgeait son cache au moment précis où il
   rouvrait la plateforme sans réseau, en réunion. Tout le dispositif hors
   ligne était là, et inaccessible. Seul un essai dans un vrai navigateur l'a
   montré : le code se lisait comme correct.

   Désormais :
     — jeton refusé (le serveur répond 401) → déconnexion, c'est une décision
       du serveur qu'on doit respecter ;
     — pas de réseau → on garde la session et on affiche ce qu'on a, avec le
       bandeau qui dit d'où viennent les données.

   Le risque résiduel est un jeton révoqué pendant une coupure : l'utilisateur
   lirait des données déjà en sa possession jusqu'au retour du réseau, où la
   vérification reprend. Lire ce qu'on a déjà lu n'est pas une fuite. */
try {
  const enregistree = sessionStorage.getItem('tontine');
  if (enregistree) {
    const reprise = JSON.parse(enregistree);
    if (reprise && reprise.jeton) {
      session = reprise;

      if (navigator.onLine === false) {
        // Inutile d'interroger le réseau pour apprendre qu'il est absent.
        demarrer();
      } else {
        appel('/authentification/session')
          .then(() => demarrer())
          .catch((err) => {
            // `appel()` a déjà appelé `deconnecter()` sur un 401 et lève alors
            // « session a expiré ». Tout autre échec est réseau : on garde la
            // session. `session.jeton` étant vidé par `deconnecter()`, le
            // tester suffit à distinguer les deux cas sans inspecter le texte
            // du message — qui, lui, pourrait changer.
            if (session.jeton) demarrer();
          });
      }
    }
  }
} catch {
  // sessionStorage indisponible : on reste sur l'écran de connexion.
}

/* ==========================================================================
   Reprise d'un cahier existant — module chargé à la demande.

   POURQUOI CET ÉCRAN EST UN MODULE SÉPARÉ, et le premier à l'avoir été. Il
   pèse 11,5 ko pour une opération qu'un groupe fait UNE FOIS dans sa vie :
   reprendre son cahier papier au moment d'adopter la plateforme. Le charger
   avec le reste faisait payer à chaque visite, à chaque membre, un écran que
   la quasi-totalité d'entre eux ne verra jamais.

   Il n'est demandé que lorsque l'onglet est ouvert — donc jamais pour un
   groupe qui porte déjà un cycle, puisque l'onglet disparaît alors.
   ========================================================================== */

import {
  afficher, aujourdhui, appel, date, francs, message, session, txt,
} from './app.js';

/* EN DEUX TEMPS, ET C'EST TOUT L'ÉCRAN. On dépose le fichier, on regarde ce
   que la plateforme y a lu, PUIS on valide. Le journal comptable étant
   immuable, un import regretté ne se défait pas : il faut détruire le groupe
   et recommencer. L'aperçu est la seule protection réelle du trésorier, et il
   ne doit pas pouvoir être sauté.

   Le contenu lu reste en mémoire entre les deux temps : le renvoyer au
   serveur tel quel garantit que ce qui est importé est exactement ce qui a été
   montré. */
let cahierEnAttente = null;

export async function ecranImport(contenu) {
  const passes = await appel('/import');

  if (passes.length > 0) {
    const p = passes[0];
    contenu.innerHTML = `
      <div class="carte"><div class="vide">
        <p><strong>Ce groupe a déjà repris un cahier.</strong></p>
        <p class="discret">
          « ${txt(p.source)} », le ${date(p.cree_le)} par ${txt(p.importe_par)} :
          ${txt(p.membres_crees)} membre(s), ${txt(p.versements_crees)} versement(s),
          ${francs(p.montant_total)}.
        </p>
        <p class="discret">
          Un cahier ne se reprend qu'une fois, dans un groupe neuf. Les
          versements suivants se saisissent normalement.
        </p>
      </div></div>`;
    return;
  }

  contenu.innerHTML = `
    <div class="formulaire">
      <h2>Reprendre un cahier existant</h2>
      <p class="discret">
        Déposez le cahier du groupe au format CSV — un export de tableur suffit.
        Vous verrez d'abord ce qui a été lu, et vous validerez ensuite.
      </p>

      <label for="fichier-cahier">Fichier du cahier</label>
      <input type="file" id="fichier-cahier" accept=".csv,text/csv,text/plain">

      <label for="indicatif">Indicatif, si les numéros sont écrits sans</label>
      <input type="text" id="indicatif" placeholder="+237" maxlength="5">

      <details>
        <summary>Quelles colonnes mettre dans le fichier ?</summary>
        <p class="discret">
          Une ligne par versement. Les en-têtes reconnus :
          <strong>nom</strong> et <strong>telephone</strong> (obligatoires),
          puis <strong>rang</strong> (ordre de passage du membre),
          <strong>tour</strong> (à quel tour se rapporte le versement),
          <strong>date</strong>, <strong>montant</strong> et
          <strong>moyen</strong>.
        </p>
        <p class="discret">
          Les dates s'écrivent JJ/MM/AAAA. Les montants sont en francs entiers :
          « 15 000 » et non « 15 000,00 ».
        </p>
      </details>
    </div>

    <div id="apercu-cahier"></div>`;

  document.getElementById('fichier-cahier')
    .addEventListener('change', lireCahier);
}

async function lireCahier(evenement) {
  const fichier = evenement.target.files && evenement.target.files[0];
  if (!fichier) return;

  const zone = document.getElementById('apercu-cahier');
  zone.innerHTML = '<div class="carte"><p class="vide">Lecture…</p></div>';

  try {
    const texte = await fichier.text();
    const indicatif = document.getElementById('indicatif').value.trim();

    const apercu = await appel('/import/apercu', {
      method: 'POST',
      body: JSON.stringify({
        contenu: texte,
        ...(indicatif ? { indicatif_defaut: indicatif } : {}),
      }),
    });

    cahierEnAttente = { contenu: texte, source: fichier.name, indicatif };
    dessinerApercu(apercu);
  } catch (err) {
    cahierEnAttente = null;
    // Le message vient du serveur et nomme la ligne fautive — « Ligne 14 :
    // date illisible ». Le relayer tel quel vaut mieux que de le remplacer.
    zone.innerHTML =
      `<div class="carte"><p class="erreur">${txt(err.message)}</p>
       <p class="discret">Corrigez le fichier et déposez-le à nouveau.</p></div>`;
  }
}

function dessinerApercu(apercu) {
  const zone = document.getElementById('apercu-cahier');

  const avertissements = apercu.avertissements.length === 0 ? '' : `
    <div class="carte">
      <h3>À noter</h3>
      ${apercu.avertissements
        .map((a) => `<p class="discret">${txt(a)}</p>`)
        .join('')}
    </div>`;

  const periode = apercu.premiere_operation
    ? `du ${date(apercu.premiere_operation)} au ${date(apercu.derniere_operation)}`
    : 'aucun versement daté';

  zone.innerHTML = `
    <div class="grille">
      <div class="chiffre">
        <span class="valeur">${txt(apercu.membres.length)}</span>
        <span class="etiquette">membres</span>
      </div>
      <div class="chiffre">
        <span class="valeur">${txt(apercu.nombre_versements)}</span>
        <span class="etiquette">versements</span>
      </div>
      <div class="chiffre">
        <span class="valeur">${francs(apercu.montant_total)}</span>
        <span class="etiquette">montant total</span>
      </div>
    </div>

    ${avertissements}

    <div class="carte">
      <h3>Ordre de passage lu dans le cahier</h3>
      <p class="discret">${txt(periode)}</p>
      ${apercu.membres.map((m, i) => `
        <div class="ligne">
          <div>
            <span class="intitule">${txt(m.nom)}</span>
            <span class="detail">${txt(m.telephone)}</span>
          </div>
          <span class="etat attente">tour ${txt(m.rang === null ? i + 1 : m.rang)}</span>
        </div>`).join('')}
    </div>

    <div class="formulaire">
      <h3>Valider la reprise</h3>
      <p class="discret">
        Vérifiez l'ordre de passage ci-dessus : il ne se modifie plus après
        validation. Les versements seront enregistrés comme s'ils avaient été
        saisis au fil de l'eau.
      </p>

      <label for="cotisation">Cotisation due par membre et par tour</label>
      <input type="number" id="cotisation" inputmode="numeric" min="1" step="1"
             placeholder="10000" required>

      <div class="duo">
        <div>
          <label for="periodicite">Périodicité</label>
          <select id="periodicite">
            <option value="MENSUELLE">Mensuelle</option>
            <option value="HEBDOMADAIRE">Hebdomadaire</option>
            <option value="QUINZAINE">Tous les quinze jours</option>
            <option value="TRIMESTRIELLE">Trimestrielle</option>
          </select>
        </div>
        <div>
          <label for="debut">Premier tour</label>
          <input type="date" id="debut"
                 value="${txt(apercu.premiere_operation || aujourdhui())}" required>
        </div>
      </div>

      <button class="principal" id="valider-import">Reprendre ce cahier</button>
    </div>`;

  document.getElementById('valider-import')
    .addEventListener('click', validerImport);
}

async function validerImport(evenement) {
  const bouton = evenement.target;
  const cotisation = Number(document.getElementById('cotisation').value);
  const periodicite = document.getElementById('periodicite').value;
  const debut = document.getElementById('debut').value;

  if (!cotisation || cotisation < 1) {
    message('Indiquez la cotisation due par chaque membre à chaque tour.', 'erreur');
    return;
  }
  if (!debut) {
    message('Indiquez la date du premier tour.', 'erreur');
    return;
  }

  // DÉSACTIVÉ PENDANT L'ENVOI. Un double clic sur ce bouton précis lancerait
  // deux imports concurrents ; le second serait refusé par l'empreinte, mais
  // l'utilisateur verrait une erreur incompréhensible après un import réussi.
  bouton.disabled = true;
  bouton.textContent = 'Reprise en cours…';

  try {
    const r = await appel('/import', {
      method: 'POST',
      body: JSON.stringify({
        contenu: cahierEnAttente.contenu,
        source: cahierEnAttente.source,
        montant_cotisation: cotisation,
        periodicite,
        date_debut: debut,
        ...(cahierEnAttente.indicatif
          ? { indicatif_defaut: cahierEnAttente.indicatif }
          : {}),
      }),
    });

    message(
      `Cahier repris : ${r.membres_crees} membre(s), ${r.tours_crees} tour(s), `
      + `${r.versements_crees} versement(s).`,
      'succes',
    );

    // Le groupe porte désormais un cycle : l'onglet d'import disparaît, et la
    // session en mémoire doit le refléter sans exiger une reconnexion.
    session.groupe.cycle_en_cours = true;
    try {
      sessionStorage.setItem('tontine', JSON.stringify(session));
    } catch { /* la session en mémoire suffit */ }

    cahierEnAttente = null;
    afficher('accueil');
  } catch (err) {
    message(err.message, 'erreur');
    bouton.disabled = false;
    bouton.textContent = 'Reprendre ce cahier';
  }
}


/* ==========================================================================
   Écrans du bureau — contrôle et vérification.

   POURQUOI ILS SONT DIFFÉRÉS. Un simple membre ne les voit jamais : les
   anomalies sont réservées au bureau (donner à chacun la liste des écarts
   constatés sur ses pairs transformerait un outil de contrôle mutuel en
   instrument de surveillance réciproque), et le rapprochement Mobile Money
   n'a de sens que pour le trésorier, seul à saisir les versements dont il
   faut vérifier la trace.

   Dans un groupe de douze, onze personnes ne téléchargeront donc jamais ce
   fichier.
   ========================================================================== */

import {
  afficher, appel, date, francs, message, txt,
} from './app.js';

/* L'ÉCRAN S'APPELLE « À VÉRIFIER », PAS « ANOMALIES » — encore moins
   « ALERTES ». Une tontine repose sur la confiance ; un outil qui désignerait
   un coupable détruirait ce qu'il prétend protéger. Chaque libellé décrit un
   constat, jamais une intention. */

export async function ecranAnomalies(contenu) {
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

/* F-TRX-06 — LE RAPPROCHEMENT NE CORRIGE RIEN.
   Il compare le relevé de l'opérateur au registre et signale les écarts dans
   les deux sens. Importer automatiquement les lignes reviendrait à laisser un
   opérateur écrire dans les comptes du groupe. */

export async function ecranRapprochement(contenu) {
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

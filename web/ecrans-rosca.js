/* ==========================================================================
   Tour de rôle — écrans propres au mécanisme ROSCA.

   POURQUOI UN MODULE PAR MÉCANISME. Les trois mécanismes s'excluent : le type
   d'un groupe est arrêté à sa création et ne change jamais (F-GRP-01). Une
   tontine rotative ne verra donc JAMAIS l'écran des prêts, ni celui des
   aides — la base elle-même refuserait ces objets.

   Les charger tous revenait à faire télécharger à chaque groupe deux écrans
   sur trois qui ne le concernent pas.
   ========================================================================== */

import {
  aRole, afficher, appel, date, dateCourte, francs, message, txt,
} from './app.js';

export async function ecranTours(contenu) {
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

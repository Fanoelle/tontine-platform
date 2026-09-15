/* ==========================================================================
   Prêts — écrans propres au mécanisme ASCA.

   Une caisse d'épargne prête à ses membres avec intérêts et échéancier. Ni
   une tontine rotative ni une mutuelle n'ont de prêts ; voir ecrans-rosca.js
   pour le raisonnement du découpage par mécanisme.
   ========================================================================== */

import {
  aRole, afficher, appel, francs, message, txt,
} from './app.js';

/* Spécialisation ASCA. L'écran montre l'encours, l'échéancier et — pour le
   président — les demandes en attente de décision. */

export async function ecranPrets(contenu) {
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

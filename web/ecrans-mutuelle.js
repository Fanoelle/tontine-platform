/* ==========================================================================
   Aides — écrans propres au mécanisme MUTUELLE.

   Une mutuelle verse des aides non remboursables lors d'événements. Ni une
   tontine rotative ni une caisse d'épargne n'en ont ; voir ecrans-rosca.js
   pour le raisonnement du découpage par mécanisme.
   ========================================================================== */

import {
  aRole, afficher, appel, date, francs, message, txt,
} from './app.js';

/* Spécialisation MUTUELLE. Une aide n'ouvre AUCUNE créance : le vocabulaire de
   l'écran ne doit jamais laisser croire qu'elle sera remboursée. */

export async function ecranAides(contenu) {
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

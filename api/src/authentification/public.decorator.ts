/**
 * Ouvre explicitement une route (N-SEC-04).
 *
 * LE SENS DE CE DÉCORATEUR EST L'INVERSE DE L'HABITUDE. Les routes sont
 * protégées par défaut — la garde est enregistrée globalement — et ce décorateur
 * les ouvre une à une.
 *
 * POURQUOI CE SENS. Oublier `@Public()` rend une route inaccessible : le défaut
 * se voit immédiatement, au premier appel. Oublier un hypothétique `@Protege()`
 * exposerait des données financières en silence, et rien ne le signalerait.
 * Entre une panne visible et une fuite silencieuse, le choix n'est pas
 * symétrique.
 */
import { SetMetadata } from '@nestjs/common';

export const CLE_PUBLIQUE = 'route_publique';

export const Public = () => SetMetadata(CLE_PUBLIQUE, true);

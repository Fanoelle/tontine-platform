/**
 * Lecture d'un cahier au format CSV.
 *
 * POURQUOI CSV ET NON XLSX. Un fichier .xlsx est une archive ZIP de XML : le
 * lire suppose une bibliothèque, et aucune n'est installable ici. Mais il y a
 * une raison plus solide que la contrainte du moment — tout tableur exporte en
 * CSV, y compris ceux qui tournent sur un téléphone, et le trésorier qui
 * n'arrive pas à importer peut OUVRIR son CSV dans un éditeur de texte et voir
 * ce qui cloche. Un .xlsx illisible est une impasse ; un CSV illisible est un
 * fichier qu'on corrige.
 *
 * CE QUE L'ANALYSEUR REFUSE DE DEVINER. Il ne corrige pas les noms de colonnes
 * approximatifs, ne réordonne pas les lignes, n'invente pas de montant
 * manquant. Devant un doute, il nomme la ligne et la colonne et s'arrête. Un
 * import silencieusement « réparé » produirait un historique faux que personne
 * ne saurait plus distinguer du vrai.
 */

export interface LigneCahier {
  membre_nom: string;
  membre_telephone: string;
  membre_email: string | null;
  rang_beneficiaire: number | null;
  tour_verse: number | null;
  date_operation: string | null;
  montant: number | null;
  moyen: string | null;
}

export interface ResultatAnalyse {
  lignes: LigneCahier[];
  /** Avertissements non bloquants, à montrer avant de confirmer l'import. */
  avertissements: string[];
}

export class ErreurCahier extends Error {
  constructor(
    message: string,
    readonly ligne: number,
  ) {
    super(`Ligne ${ligne} : ${message}`);
    this.name = 'ErreurCahier';
  }
}

/**
 * Les colonnes attendues, et leurs graphies tolérées.
 *
 * LA TOLÉRANCE EST DÉLIBÉRÉMENT ÉTROITE : accents, casse et espaces varient
 * d'un tableur à l'autre et d'une machine à l'autre, ce sont des différences
 * de forme. « telephone » et « tel » désignent sans ambiguïté la même chose.
 * En revanche rien n'est deviné par proximité : une colonne « montan » n'est
 * pas reconnue, parce qu'accepter une faute de frappe ouvrirait la porte à
 * prendre « montant_prevu » pour « montant ».
 */
const COLONNES: Record<keyof LigneCahier, string[]> = {
  membre_nom: ['nom', 'membre', 'nom_complet', 'nom complet', 'prenom nom'],
  membre_telephone: ['telephone', 'tel', 'numero', 'contact', 'portable'],
  membre_email: ['email', 'mail', 'courriel', 'adresse email'],
  rang_beneficiaire: ['rang', 'rang_beneficiaire', 'ordre', 'position', 'tour_recu'],
  tour_verse: ['tour', 'tour_verse', 'echeance', 'mois', 'numero_tour'],
  date_operation: ['date', 'date_versement', 'date_operation', 'jour'],
  montant: ['montant', 'somme', 'verse', 'montant_verse', 'cotisation'],
  moyen: ['moyen', 'mode', 'moyen_paiement', 'mode_paiement', 'paiement'],
};

const MOYENS = ['ESPECES', 'MOBILE_MONEY', 'VIREMENT', 'COMPENSATION'];

/** Réduit un en-tête à sa forme comparable : sans accent, sans ponctuation. */
function normaliser(valeur: string): string {
  return valeur
    .trim()
    .toLowerCase()
    .normalize('NFD')
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Découpe une ligne CSV en respectant les guillemets.
 *
 * ÉCRIT À LA MAIN PLUTÔT QUE PAR `split(',')`, PARCE QUE LES NOMS CONTIENNENT
 * DES VIRGULES. « Diop, Awa » est une graphie courante, et un découpage naïf
 * la transformerait en deux colonnes, décalant toute la ligne. Le guillemet
 * doublé (`""`) est la façon dont un tableur échappe un guillemet littéral.
 */
export function decouperLigne(ligne: string, separateur: string): string[] {
  const champs: string[] = [];
  let courant = '';
  let entreGuillemets = false;
  let i = 0;

  while (i < ligne.length) {
    const c = ligne[i];

    if (entreGuillemets) {
      if (c === '"') {
        if (ligne[i + 1] === '"') {
          courant += '"';
          i += 2;
          continue;
        }
        entreGuillemets = false;
        i += 1;
        continue;
      }
      courant += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      entreGuillemets = true;
      i += 1;
      continue;
    }

    if (c === separateur) {
      champs.push(courant.trim());
      courant = '';
      i += 1;
      continue;
    }

    courant += c;
    i += 1;
  }

  champs.push(courant.trim());
  return champs;
}

/**
 * Devine le séparateur : virgule, point-virgule ou tabulation.
 *
 * LE POINT-VIRGULE N'EST PAS UN DÉTAIL LOCAL. Excel en français l'utilise par
 * défaut, parce que la virgule y est le séparateur décimal. Un import qui
 * n'accepterait que la virgule échouerait sur la majorité des fichiers
 * produits par les utilisateurs visés, et l'erreur — « une seule colonne
 * trouvée » — ne leur dirait rien.
 */
function devinerSeparateur(entete: string): string {
  const candidats = [';', ',', '\t'];
  let meilleur = ',';
  let maximum = 0;

  for (const candidat of candidats) {
    const nombre = decouperLigne(entete, candidat).length;
    if (nombre > maximum) {
      maximum = nombre;
      meilleur = candidat;
    }
  }

  return meilleur;
}

/** Lit un entier, ou rend null si la case est vide. */
function lireEntier(
  brut: string,
  champ: string,
  numeroLigne: number,
): number | null {
  if (!brut) return null;

  const nombre = Number(brut.replace(/\s/g, ''));
  if (!Number.isInteger(nombre) || nombre < 1) {
    throw new ErreurCahier(
      `« ${champ} » doit être un entier positif, reçu « ${brut} »`,
      numeroLigne,
    );
  }
  return nombre;
}

/**
 * Lit un montant en unités entières de devise.
 *
 * LES SÉPARATEURS DE MILLIERS SONT RETIRÉS : « 15 000 », « 15.000 » et
 * « 15,000 » désignent tous quinze mille dans un cahier tenu en francs CFA.
 * Le franc CFA n'a pas de centimes — un montant décimal est donc une erreur
 * de saisie, pas une précision, et il est refusé plutôt qu'arrondi en silence.
 */
function lireMontant(brut: string, numeroLigne: number): number | null {
  if (!brut) return null;

  // LA PARTIE DÉCIMALE EST DÉTECTÉE AVANT TOUT NETTOYAGE, et ce contrôle est
  // né d'un test qui a échoué. La version précédente retirait les virgules et
  // les lettres sans distinction : « 150,00 F » devenait « 15000 ». Cent
  // cinquante francs importés comme quinze mille, silencieusement, dans un
  // journal immuable.
  //
  // Un séparateur décimal se reconnaît à ce qui le suit : exactement un ou
  // deux chiffres en fin de nombre. « 15.000 » est quinze mille (trois
  // chiffres, séparateur de milliers) ; « 150,00 » est cent cinquante.
  const decimal = brut.match(/[.,](\d{1,2})(?:\s*[A-Za-z]*)?$/);
  if (decimal) {
    throw new ErreurCahier(
      `Montant à centimes : « ${brut} ». Le franc CFA n'a pas de subdivision — `
        + 'si vous vouliez écrire un millier, utilisez un espace '
        + '(« 15 000 ») plutôt qu\'un point ou une virgule.',
      numeroLigne,
    );
  }

  // Les séparateurs de milliers, eux, sont retirés : « 15 000 », « 15.000 » et
  // « 15'000 » désignent tous quinze mille. Le suffixe de devise (« F »,
  // « FCFA », « XAF ») est toléré : les cahiers en portent souvent un.
  const nettoye = brut.replace(/[\s.,'  ]/g, '').replace(/[A-Za-z]/g, '');

  if (!/^\d+$/.test(nettoye)) {
    throw new ErreurCahier(
      `Montant illisible : « ${brut} ». Attendu un nombre entier, `
        + 'sans centimes.',
      numeroLigne,
    );
  }

  const montant = Number(nettoye);
  if (montant <= 0) {
    throw new ErreurCahier(
      `Montant nul ou négatif : « ${brut} »`,
      numeroLigne,
    );
  }

  return montant;
}

/**
 * Normalise une date vers AAAA-MM-JJ.
 *
 * JJ/MM/AAAA EST PRÉSUMÉ, jamais MM/JJ/AAAA. C'est la convention du public
 * visé, et l'ambiguïté est irréductible pour les douze premiers jours du mois :
 * 03/04/2025 est soit le 3 avril, soit le 4 mars. Poser la convention et la
 * documenter vaut mieux que de deviner au cas par cas — un import dont les
 * dates seraient tantôt lues d'une façon, tantôt de l'autre serait ingérable.
 */
function lireDate(brut: string, numeroLigne: number): string | null {
  if (!brut) return null;

  const iso = brut.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return brut;

  const local = brut.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (local) {
    const [, jour, mois, annee] = local;
    const j = Number(jour);
    const m = Number(mois);

    if (m < 1 || m > 12 || j < 1 || j > 31) {
      throw new ErreurCahier(`Date impossible : « ${brut} »`, numeroLigne);
    }

    return `${annee}-${String(m).padStart(2, '0')}-${String(j).padStart(2, '0')}`;
  }

  throw new ErreurCahier(
    `Date illisible : « ${brut} ». Attendu JJ/MM/AAAA ou AAAA-MM-JJ.`,
    numeroLigne,
  );
}

/**
 * Normalise un numéro de téléphone au format international.
 *
 * LE PRÉFIXE PAYS EST EXIGÉ, et ce n'est pas de la rigidité administrative :
 * la contrainte `membre_telephone_check` de la base l'impose, et surtout un
 * numéro sans indicatif ne permet aucun envoi de SMS. Un « 690 11 00 02 »
 * dans un cahier camerounais est parfaitement clair pour un humain, et
 * totalement ambigu pour une passerelle.
 */
function lireTelephone(
  brut: string,
  numeroLigne: number,
  indicatifDefaut: string | null,
): string {
  const compact = brut.replace(/[\s.()-]/g, '');

  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;

  // « 00237... » est l'autre façon d'écrire « +237... ».
  if (/^00[1-9]\d{7,14}$/.test(compact)) return `+${compact.slice(2)}`;

  if (/^\d{6,12}$/.test(compact) && indicatifDefaut) {
    const sansZero = compact.replace(/^0+/, '');
    const complet = `${indicatifDefaut}${sansZero}`;
    if (/^\+[1-9]\d{7,14}$/.test(complet)) return complet;
  }

  throw new ErreurCahier(
    `Téléphone illisible : « ${brut} ». Attendu un numéro international `
      + '(+237690110002). Précisez un indicatif par défaut pour accepter les '
      + 'numéros locaux.',
    numeroLigne,
  );
}

export interface OptionsAnalyse {
  /** Indicatif appliqué aux numéros sans préfixe, par exemple « +237 ». */
  indicatifDefaut?: string;
}

/**
 * Analyse un cahier complet.
 *
 * TOUTES LES ERREURS DE FORME SONT LEVÉES À LA PREMIÈRE RENCONTRÉE. Un rapport
 * exhaustif serait plus confortable, mais les erreurs d'un CSV sont
 * généralement systématiques — un mauvais format de date touche les trois cents
 * lignes — et lister trois cents fois la même chose n'aide personne.
 */
export function analyserCahier(
  contenu: string,
  options: OptionsAnalyse = {},
): ResultatAnalyse {
  // Le BOM que produisent les tableurs Windows deviendrait le premier
  // caractère du premier en-tête, rendant « nom » méconnaissable.
  const texte = contenu.replace(/^﻿/, '');

  const lignesBrutes = texte
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  if (lignesBrutes.length < 2) {
    throw new ErreurCahier(
      'Le fichier ne contient pas de données — une ligne d\'en-tête et au '
        + 'moins une ligne de cahier sont attendues.',
      0,
    );
  }

  const separateur = devinerSeparateur(lignesBrutes[0]);
  const entetes = decouperLigne(lignesBrutes[0], separateur).map(normaliser);

  // Correspondance en-tête → champ.
  const position: Partial<Record<keyof LigneCahier, number>> = {};
  for (const [champ, graphies] of Object.entries(COLONNES) as [
    keyof LigneCahier,
    string[],
  ][]) {
    const index = entetes.findIndex((e) =>
      graphies.some((g) => normaliser(g) === e),
    );
    if (index !== -1) position[champ] = index;
  }

  const avertissements: string[] = [];

  if (position.membre_nom === undefined) {
    throw new ErreurCahier(
      `Colonne « nom » introuvable. En-têtes lus : ${entetes.join(', ')}. `
        + `Graphies acceptées : ${COLONNES.membre_nom.join(', ')}.`,
      1,
    );
  }

  if (position.membre_telephone === undefined) {
    throw new ErreurCahier(
      `Colonne « telephone » introuvable. En-têtes lus : ${entetes.join(', ')}. `
        + 'Le téléphone identifie le membre — sans lui, deux homonymes sont '
        + 'indiscernables.',
      1,
    );
  }

  if (position.montant === undefined) {
    avertissements.push(
      'Aucune colonne « montant » : seuls les membres et l\'ordre de passage '
        + 'seront importés, sans aucun versement.',
    );
  }

  if (position.rang_beneficiaire === undefined) {
    avertissements.push(
      'Aucune colonne « rang » : l\'ordre de passage suivra l\'ordre des '
        + 'lignes du fichier.',
    );
  }

  const lignes: LigneCahier[] = [];
  const indicatif = options.indicatifDefaut?.trim() || null;

  for (let i = 1; i < lignesBrutes.length; i += 1) {
    // +1 pour compter depuis 1 comme un tableur, l'en-tête étant la ligne 1.
    const numero = i + 1;
    const champs = decouperLigne(lignesBrutes[i], separateur);

    const lire = (champ: keyof LigneCahier): string => {
      const index = position[champ];
      if (index === undefined) return '';
      return (champs[index] ?? '').trim();
    };

    const nom = lire('membre_nom');
    const telephone = lire('membre_telephone');

    if (!nom && !telephone) continue; // ligne de séparation dans le tableur

    if (!nom) {
      throw new ErreurCahier('Le nom du membre est vide', numero);
    }
    if (!telephone) {
      throw new ErreurCahier(`Téléphone manquant pour « ${nom} »`, numero);
    }

    const email = lire('membre_email');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new ErreurCahier(
        `Courriel illisible : « ${email} ». Laissez la case vide s'il est `
          + 'inconnu.',
        numero,
      );
    }

    const moyenBrut = lire('moyen');
    let moyen: string | null = null;
    if (moyenBrut) {
      const candidat = normaliser(moyenBrut).replace(/ /g, '_').toUpperCase();
      const correspondances: Record<string, string> = {
        ESPECE: 'ESPECES',
        ESPECES: 'ESPECES',
        CASH: 'ESPECES',
        LIQUIDE: 'ESPECES',
        MOBILE_MONEY: 'MOBILE_MONEY',
        MOBILE: 'MOBILE_MONEY',
        MOMO: 'MOBILE_MONEY',
        OM: 'MOBILE_MONEY',
        ORANGE_MONEY: 'MOBILE_MONEY',
        MTN_MONEY: 'MOBILE_MONEY',
        VIREMENT: 'VIREMENT',
        BANQUE: 'VIREMENT',
        CHEQUE: 'VIREMENT',
        COMPENSATION: 'COMPENSATION',
      };
      moyen = correspondances[candidat] ?? null;

      if (!moyen) {
        throw new ErreurCahier(
          `Moyen de paiement inconnu : « ${moyenBrut} ». `
            + `Attendu l'un de : ${MOYENS.join(', ')}.`,
          numero,
        );
      }
    }

    const montant = lireMontant(lire('montant'), numero);
    const date = lireDate(lire('date_operation'), numero);

    if (montant !== null && date === null) {
      throw new ErreurCahier(
        `Versement de ${montant} sans date. Une écriture comptable sans date `
          + 'est inexploitable.',
        numero,
      );
    }

    lignes.push({
      membre_nom: nom,
      membre_telephone: lireTelephone(telephone, numero, indicatif),
      membre_email: email || null,
      rang_beneficiaire: lireEntier(lire('rang_beneficiaire'), 'rang', numero),
      tour_verse: lireEntier(lire('tour_verse'), 'tour', numero),
      date_operation: date,
      montant,
      moyen,
    });
  }

  if (lignes.length === 0) {
    throw new ErreurCahier('Aucune ligne exploitable dans le fichier', 0);
  }

  // COHÉRENCE DES RANGS — vérifiée ici plutôt qu'en base, parce que c'est ici
  // qu'on peut encore nommer la ligne fautive.
  const rangs = new Map<string, number>();
  for (const ligne of lignes) {
    if (ligne.rang_beneficiaire === null) continue;
    const connu = rangs.get(ligne.membre_telephone);
    if (connu !== undefined && connu !== ligne.rang_beneficiaire) {
      throw new ErreurCahier(
        `« ${ligne.membre_nom} » porte deux rangs différents (${connu} et `
          + `${ligne.rang_beneficiaire}). Un membre ne touche la cagnotte `
          + 'qu\'une fois par cycle.',
        0,
      );
    }
    rangs.set(ligne.membre_telephone, ligne.rang_beneficiaire);
  }

  const rangsUtilises = [...rangs.values()];
  const doublons = rangsUtilises.filter(
    (r, i) => rangsUtilises.indexOf(r) !== i,
  );
  if (doublons.length > 0) {
    throw new ErreurCahier(
      `Deux membres partagent le rang ${doublons[0]} — l'ordre de passage `
        + 'doit être sans ambiguïté.',
      0,
    );
  }

  return { lignes, avertissements };
}

/**
 * Reprise d'un cahier existant.
 *
 * LE SERVICE NE FAIT PRESQUE RIEN, et c'est voulu. L'analyse du CSV est dans
 * `cahier.analyseur.ts`, la construction du groupe dans `importer_cahier()`.
 * Ce qui reste ici est la jonction : lire, prévisualiser, appliquer.
 *
 * LA PRÉVISUALISATION EST LA FONCTION IMPORTANTE. Un import est une opération
 * lourde et à peu près irréversible du point de vue de l'utilisateur — le
 * journal étant immuable, revenir en arrière suppose de détruire le groupe.
 * Montrer ce qui SERA fait avant de le faire n'est donc pas une commodité,
 * c'est la seule protection dont dispose le trésorier.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { BaseService } from '../base/base.service';
import type { Session } from '../authentification/session';
import {
  ErreurCahier,
  analyserCahier,
  type LigneCahier,
} from './cahier.analyseur';

export interface Apercu {
  membres: { nom: string; telephone: string; rang: number | null }[];
  nombre_versements: number;
  montant_total: number;
  premiere_operation: string | null;
  derniere_operation: string | null;
  tours_estimes: number;
  avertissements: string[];
  empreinte: string;
}

export interface ResultatImport {
  import_id: string;
  membres_crees: number;
  tours_crees: number;
  versements_crees: number;
  montant_total: number;
}

@Injectable()
export class ImportService {
  private readonly journal = new Logger(ImportService.name);

  constructor(private readonly base: BaseService) {}

  /**
   * Lit le fichier et rend ce que l'import ferait, SANS rien écrire.
   *
   * Les erreurs de forme remontent ici, avant toute transaction : l'exploitant
   * corrige son fichier et recommence sans avoir touché la base.
   */
  apercu(contenu: string, indicatifDefaut?: string): Apercu {
    const { lignes, avertissements } = this.analyser(contenu, indicatifDefaut);

    const membres = new Map<
      string,
      { nom: string; telephone: string; rang: number | null }
    >();
    for (const ligne of lignes) {
      if (!membres.has(ligne.membre_telephone)) {
        membres.set(ligne.membre_telephone, {
          nom: ligne.membre_nom,
          telephone: ligne.membre_telephone,
          rang: ligne.rang_beneficiaire,
        });
      }
    }

    const versements = lignes.filter((l) => l.montant !== null);
    const dates = versements
      .map((l) => l.date_operation)
      .filter((d): d is string => d !== null)
      .sort();

    return {
      // Triés comme ils passeront : rang déclaré d'abord, puis ordre du fichier.
      membres: [...membres.values()].sort(
        (a, b) => (a.rang ?? 9999) - (b.rang ?? 9999),
      ),
      nombre_versements: versements.length,
      montant_total: versements.reduce((t, l) => t + (l.montant ?? 0), 0),
      premiere_operation: dates[0] ?? null,
      derniere_operation: dates[dates.length - 1] ?? null,
      // Un tour par membre : c'est la définition d'un cycle de tontine.
      tours_estimes: membres.size,
      avertissements,
      empreinte: this.empreinte(contenu),
    };
  }

  /**
   * Applique l'import. Tout ou rien.
   *
   * LE GROUPE VIENT DU JETON (N-SEC-03), jamais du fichier. Un cahier qui
   * porterait un identifiant de groupe permettrait à un trésorier d'écrire
   * dans le groupe d'un autre — c'est exactement la faille que la session
   * ferme partout ailleurs, et l'import n'y fait pas exception.
   */
  async appliquer(
    session: Session,
    contenu: string,
    source: string,
    montantCotisation: number,
    periodicite: string,
    dateDebut: string,
    indicatifDefaut?: string,
  ): Promise<ResultatImport> {
    const { lignes } = this.analyser(contenu, indicatifDefaut);

    const dejaImporte = await this.base.requeteUne<{ cree_le: string }>(
      `SELECT cree_le FROM import WHERE groupe_id = $1 AND empreinte = $2`,
      [session.groupe_id, this.empreinte(contenu)],
    );

    if (dejaImporte) {
      // Message DATÉ : « déjà importé » sans date laisserait l'utilisateur se
      // demander s'il parle du même fichier ou d'un homonyme.
      throw new ConflictException(
        `Ce fichier a déjà été importé le `
          + `${new Date(dejaImporte.cree_le).toLocaleDateString('fr-FR')}.`,
      );
    }

    // Le tableau de composites est construit ici plutôt qu'en SQL : `pg` sait
    // sérialiser un tableau d'objets vers un type composite, à condition que
    // l'ordre des champs corresponde à la déclaration du type.
    const tableau = lignes.map((l) => this.versComposite(l));

    try {
      const resultat = await this.base.requeteUne<ResultatImport>(
        `SELECT * FROM importer_cahier($1, $2, $3, $4, $5, $6::periodicite,
                                        $7::DATE, $8::ligne_cahier[])`,
        [
          session.groupe_id,
          session.membre_id,
          source,
          this.empreinte(contenu),
          montantCotisation,
          periodicite,
          dateDebut,
          tableau,
        ],
      );

      this.journal.log(
        `Cahier « ${source} » importé dans le groupe ${session.groupe_id} : `
          + `${resultat!.versements_crees} versement(s), `
          + `${resultat!.montant_total} au total`,
      );

      return {
        import_id: resultat!.import_id,
        membres_crees: Number(resultat!.membres_crees),
        tours_crees: Number(resultat!.tours_crees),
        versements_crees: Number(resultat!.versements_crees),
        montant_total: Number(resultat!.montant_total),
      };
    } catch (erreur) {
      throw this.traduire(erreur as Error & { code?: string });
    }
  }

  /** Les imports déjà effectués dans ce groupe. */
  async historique(session: Session) {
    return this.base.requete(
      `SELECT id, source, importe_par, membres_crees, tours_crees,
              versements_crees, montant_total, cree_le
         FROM v_import
        WHERE groupe_id = $1`,
      [session.groupe_id],
    );
  }

  private analyser(contenu: string, indicatifDefaut?: string) {
    try {
      return analyserCahier(contenu, { indicatifDefaut });
    } catch (erreur) {
      if (erreur instanceof ErreurCahier) {
        // 400 et non 500 : le fichier est en cause, pas le serveur. La
        // distinction compte pour qui lit les journaux d'exploitation.
        throw new BadRequestException(erreur.message);
      }
      throw erreur;
    }
  }

  /**
   * Empreinte du contenu, insensible aux fins de ligne.
   *
   * Le même fichier envoyé depuis Windows puis depuis un téléphone diffère par
   * ses CRLF. Sans normalisation, la détection de doublon le laisserait passer
   * deux fois — et le groupe verrait son historique dupliqué.
   */
  private empreinte(contenu: string): string {
    return createHash('sha256')
      .update(contenu.replace(/\r\n/g, '\n').trim())
      .digest('hex');
  }

  private versComposite(ligne: LigneCahier): string {
    // Format composite PostgreSQL : (a,b,c). Les champs textuels sont mis
    // entre guillemets et leurs guillemets internes doublés — un nom comme
    // « N'Diaye "Le Grand" » casserait la syntaxe sans cela.
    const texte = (valeur: string | null): string =>
      valeur === null ? '' : `"${valeur.replace(/(["\\])/g, '\\$1')}"`;
    const nombre = (valeur: number | null): string =>
      valeur === null ? '' : String(valeur);

    return (
      '(' +
      [
        texte(ligne.membre_nom),
        texte(ligne.membre_telephone),
        texte(ligne.membre_email),
        nombre(ligne.rang_beneficiaire),
        nombre(ligne.tour_verse),
        texte(ligne.date_operation),
        nombre(ligne.montant),
        texte(ligne.moyen),
      ].join(',') +
      ')'
    );
  }

  /**
   * Traduit une erreur PostgreSQL en réponse HTTP juste.
   *
   * SANS CELA, TOUT REFUS MÉTIER DEVIENDRAIT UN 500. « Ce groupe porte déjà un
   * cycle » est une information destinée à l'utilisateur, pas une panne : la
   * rendre en 500 le laisserait croire à un défaut du serveur et l'inciterait
   * à réessayer à l'identique.
   */
  private traduire(erreur: Error & { code?: string }): Error {
    const message = erreur.message ?? 'Import impossible';

    switch (erreur.code) {
      case 'insufficient_privilege':
      case '42501':
        return new ForbiddenException(message);

      case 'object_not_in_prerequisite_state':
      case '55000':
        return new ConflictException(message);

      case 'feature_not_supported':
      case '0A000':
      case 'invalid_parameter_value':
      case '22023':
      case 'no_data_found':
      case 'P0002':
        return new BadRequestException(message);

      case '23514': // violation d'une contrainte CHECK
        return new BadRequestException(
          `Une donnée du cahier viole une règle de la base : ${message}`,
        );

      case '23505': // violation d'unicité
        return new ConflictException(
          `Doublon détecté : ${message}`,
        );

      default:
        return erreur;
    }
  }
}

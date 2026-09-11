/**
 * Accès à PostgreSQL en SQL brut.
 *
 * POURQUOI PAS D'ORM. Le schéma porte la logique métier (décision 0001) :
 * équilibre des écritures par déclencheur, unicité du bénéficiaire par index,
 * immuabilité par révocation de privilèges. Un ORM masquerait précisément ce qui
 * fait la sûreté du modèle, et produirait des requêtes que l'on ne contrôle plus.
 * Le coût assumé : écrire ses requêtes à la main et déclarer ses types de lignes.
 *
 * LE RÔLE APPLICATIF EST BRIDÉ. La connexion utilise `tontine_app`, dont les
 * privilèges UPDATE et DELETE sont révoqués sur `ecriture` et `ligne_ecriture`
 * (migration 003). Se connecter en superutilisateur annulerait ce second verrou
 * de R-02 et ne laisserait que le déclencheur — or N-INT-02 en exige deux.
 */
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResultRow } from 'pg';

@Injectable()
export class BaseService implements OnModuleInit, OnModuleDestroy {
  private readonly journal = new Logger(BaseService.name);
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      host: config.get<string>('BASE_HOTE', 'localhost'),
      port: config.get<number>('BASE_PORT', 55433),
      database: config.get<string>('BASE_NOM', 'tontine'),
      user: config.get<string>('BASE_UTILISATEUR', 'tontine_app'),
      password: config.get<string>('BASE_MOT_DE_PASSE', 'dev'),
      max: config.get<number>('BASE_CONNEXIONS_MAX', 10),

      // Une requête qui dépasse 10 s est un défaut, pas une lenteur : N-PRF-01
      // vise 300 ms au 95e centile. Mieux vaut échouer vite et visiblement que
      // laisser une connexion occupée indéfiniment.
      statement_timeout: 10_000,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    // Une erreur sur un client inactif du pool ne remonte nulle part sans cet
    // écouteur : elle ferait tomber le processus Node entier.
    this.pool.on('error', (erreur) => {
      this.journal.error(
        `Erreur sur une connexion inactive : ${erreur.message}`,
        erreur.stack,
      );
    });
  }

  async onModuleInit(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ version: string; role: string }>(
        'SELECT version() AS version, current_user AS role',
      );
      this.journal.log(`Connecté en tant que « ${rows[0].role} »`);

      // Vérification au démarrage plutôt qu'à la première écriture : si le rôle
      // dispose de privilèges qu'il ne devrait pas avoir, on veut le savoir
      // maintenant, pas le jour où une écriture est modifiée en production.
      await this.verifierPrivilegesJournal(client);
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  /**
   * R-02 — le rôle applicatif ne doit posséder ni UPDATE ni DELETE sur le
   * journal. La migration 003 les révoque ; ce contrôle vérifie que la base
   * exécutée est bien celle qu'on croit.
   */
  private async verifierPrivilegesJournal(client: PoolClient): Promise<void> {
    const { rows } = await client.query<{ interdits: string | null }>(
      `SELECT string_agg(DISTINCT table_name || '.' || privilege_type, ', ')
                AS interdits
         FROM information_schema.table_privileges
        WHERE grantee = current_user
          AND table_name IN ('ecriture', 'ligne_ecriture')
          AND privilege_type IN ('UPDATE', 'DELETE')`,
    );

    const interdits = rows[0]?.interdits;
    if (interdits) {
      this.journal.error(
        `R-02 COMPROMIS : le rôle « ${await this.roleCourant(client)} » détient ` +
          `des privilèges qui doivent être révoqués (${interdits}). ` +
          `Réappliquez db/migrations/003_cycle_rosca.sql.`,
      );
    } else {
      this.journal.log('R-02 vérifié : journal non modifiable par ce rôle');
    }
  }

  private async roleCourant(client: PoolClient): Promise<string> {
    const { rows } = await client.query<{ role: string }>(
      'SELECT current_user AS role',
    );
    return rows[0].role;
  }

  /** Requête simple, hors transaction. */
  async requete<T extends QueryResultRow>(
    sql: string,
    parametres: readonly unknown[] = [],
  ): Promise<T[]> {
    const { rows } = await this.pool.query<T>(sql, [...parametres]);
    return rows;
  }

  /** Requête dont on attend exactement zéro ou une ligne. */
  async requeteUne<T extends QueryResultRow>(
    sql: string,
    parametres: readonly unknown[] = [],
  ): Promise<T | null> {
    const lignes = await this.requete<T>(sql, parametres);
    return lignes[0] ?? null;
  }

  /**
   * Exécute une suite d'opérations dans UNE transaction (N-INT-04).
   *
   * Indispensable au journal : l'équilibre R-01 est vérifié par un déclencheur
   * DIFFÉRÉ, donc au COMMIT. Insérer une écriture et ses lignes hors d'une
   * transaction unique validerait chaque ligne isolément — et l'écriture serait
   * nécessairement déséquilibrée entre la première et la dernière.
   *
   * Toute exception annule l'intégralité : ni écriture, ni ligne, ni imputation
   * ne subsiste.
   */
  async transaction<T>(
    operations: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const resultat = await operations(client);
      await client.query('COMMIT');
      return resultat;
    } catch (erreur) {
      await client.query('ROLLBACK');
      throw erreur;
    } finally {
      client.release();
    }
  }
}

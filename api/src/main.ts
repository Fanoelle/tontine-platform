import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';

async function demarrer(): Promise<void> {
  const application = await NestFactory.create<NestExpressApplication>(AppModule);
  const journal = new Logger('Démarrage');

  // L'interface est servie par l'API elle-même, en fichiers statiques.
  //
  // POURQUOI PAS @nestjs/serve-static NI UN SERVEUR SÉPARÉ. Le module dédié
  // n'apporterait qu'une couche de configuration par-dessus `useStaticAssets`,
  // déjà fourni par l'adaptateur Express. Un serveur séparé imposerait un
  // second processus et une configuration CORS — alors que servir la page
  // depuis la même origine que l'API supprime la question entière.
  //
  // Le préfixe /api étant posé ci-dessous, aucune collision n'est possible
  // entre les routes de l'API et les fichiers de l'interface.
  // LE DOSSIER ALLÉGÉ EST PRÉFÉRÉ, AVEC REPLI SUR LA SOURCE.
  //
  // `web-servi/` contient les mêmes fichiers sans leurs commentaires : 90,6 ko
  // deviennent 74,7, ce qui rend de la marge sous les 100 ko de N-USG-02.
  //
  // Le repli n'est pas une précaution de façade. Un développeur qui clone le
  // dépôt n'a pas encore lancé `scripts/construire-web.py` — `web-servi/` est
  // un artefact, ignoré par git. Sans repli, il verrait une page blanche et
  // chercherait la panne du mauvais côté.
  const racineWeb = join(__dirname, '..', '..');
  const allege = join(racineWeb, 'web-servi');
  const source = join(racineWeb, 'web');
  const dossierWeb = existsSync(join(allege, 'index.html')) ? allege : source;

  application.useStaticAssets(dossierWeb);
  journal.log(
    dossierWeb === allege
      ? 'Interface servie depuis web-servi/ (allégée)'
      : 'Interface servie depuis web/ — lancez scripts/construire-web.py '
        + 'pour alléger',
  );

  application.setGlobalPrefix('api');

  // SANS CET APPEL, `onApplicationShutdown` N'EST JAMAIS INVOQUÉ. Nest ne
  // s'abonne aux signaux du système que si on le lui demande. Le planificateur
  // de rappels s'en sert pour arrêter son minuteur, et le pool de connexions
  // pour se fermer proprement — sans quoi un redémarrage laisserait des
  // connexions ouvertes côté PostgreSQL jusqu'à leur expiration.
  application.enableShutdownHooks();

  application.useGlobalPipes(
    new ValidationPipe({
      // Une propriété non déclarée dans le DTO est RETIRÉE, et sa présence fait
      // échouer la requête. Sans cela, un client pourrait poster `groupe_id` et
      // espérer qu'un service le lise un jour — exactement la faille que
      // N-SEC-03 ferme en tirant le groupe du jeton.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // 3100 par défaut : le 3000 est occupé par un autre projet de cette machine,
  // et ce projet ne partage ni port, ni base, ni dépendance avec eux.
  const port = process.env.PORT ?? 3100;
  await application.listen(port);
  journal.log(`API à l'écoute sur http://localhost:${port}/api`);
}

void demarrer();

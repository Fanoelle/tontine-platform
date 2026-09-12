import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
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
  application.useStaticAssets(join(__dirname, '..', '..', 'web'));

  application.setGlobalPrefix('api');

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

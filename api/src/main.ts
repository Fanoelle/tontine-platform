import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function demarrer(): Promise<void> {
  const application = await NestFactory.create(AppModule);
  const journal = new Logger('Démarrage');

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

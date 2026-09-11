import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthentificationControleur } from './authentification.controleur';
import { AuthentificationService } from './authentification.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          // Assez long pour une séance de saisie, assez court pour qu'une
          // révocation de rôle prenne effet dans la journée. La garde relit
          // néanmoins la base à chaque appel : une suspension est immédiate.
          expiresIn: config.get<string>('JWT_DUREE', '12h'),
        },
      }),
    }),
  ],
  controllers: [AuthentificationControleur],
  providers: [AuthentificationService],
  exports: [AuthentificationService, JwtModule],
})
export class AuthentificationModule {}

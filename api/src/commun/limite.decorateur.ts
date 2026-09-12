import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Injecte le paramètre `limite` d'une query string, borné et avec défaut.
 *
 * POURQUOI UN DÉCORATEUR PLUTÔT QU'UN PIPE. Trois tentatives ont échoué avant
 * celle-ci, et chacune a appris quelque chose :
 *
 * 1. `ParseIntPipe({ optional: true })` refuse une valeur absente avec
 *    « numeric string is expected » — l'option ne couvre pas `undefined`.
 *
 * 2. Un pipe maison gérant `undefined` ne suffit pas non plus : le
 *    `ValidationPipe` GLOBAL, configuré avec `transform: true`, convertit
 *    d'abord le paramètre vers le type déclaré. Pour `limite: number` absent,
 *    il produit `NaN` et rejette AVANT que le pipe ne soit consulté.
 *
 * 3. Déclarer `limite: string | undefined` contourne la conversion, mais fait
 *    mentir la signature : le pipe rend un nombre, pas une chaîne.
 *
 * Un décorateur de paramètre lit la requête directement, sans passer par la
 * chaîne de pipes. Le type déclaré correspond alors à ce qui est réellement
 * injecté — et c'est ce qui rend le code honnête.
 *
 * LE DÉFAUT ÉTAIT RESTÉ INVISIBLE parce que l'interface envoie toujours
 * `?limite=`. Il ne se manifestait que pour un appel direct : un commissaire
 * qui explore l'API, un script d'export. Une route dont les paramètres
 * facultatifs sont en réalité obligatoires n'est pas une route facultative.
 */
export const Limite = createParamDecorator(
  (options: { defaut?: number; maximum?: number } | undefined,
   contexte: ExecutionContext): number => {
    const { defaut = 100, maximum = 500 } = options ?? {};
    const requete = contexte.switchToHttp().getRequest<Request>();
    const brut = requete.query?.limite;

    if (brut === undefined || brut === null || brut === '') {
      return defaut;
    }

    // Une query string peut porter le même paramètre deux fois — `?limite=1&limite=2`
    // arrive alors sous forme de tableau. On refuse plutôt que de choisir
    // arbitrairement : l'appelant doit savoir ce qu'il demande.
    if (Array.isArray(brut)) {
      throw new BadRequestException(
        'Le paramètre « limite » ne doit être fourni qu\'une fois',
      );
    }

    const nombre = Number(brut);

    if (!Number.isInteger(nombre) || nombre < 1) {
      throw new BadRequestException(
        'La limite doit être un nombre entier positif',
      );
    }

    // Bornage : une limite de 100 000 ferait tomber la réponse dans le vide
    // plutôt que de servir quiconque.
    return Math.min(nombre, maximum);
  },
);

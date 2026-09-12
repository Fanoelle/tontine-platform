/**
 * Serveur SMTP de test — assez complet pour éprouver le client, et rien de plus.
 *
 * POURQUOI UN SERVEUR MAISON. Éprouver un client SMTP contre un faux objet ne
 * prouverait que la cohérence du code avec lui-même. Ce serveur parle le vrai
 * protocole sur une vraie prise TCP : réponses multi-lignes, codes d'erreur,
 * point final, authentification. Ce qui passe ici passera devant un serveur
 * réel, aux extensions près.
 *
 * IL PERMET DE SIMULER LES PANNES, et c'est la moitié de son intérêt : un refus
 * 550 définitif, un refus 451 temporaire, une coupure en plein DATA. Ces
 * chemins-là sont ceux qu'on ne voit jamais en développement et toujours en
 * production.
 */
import { createServer, type Server, type Socket } from 'node:net';

export interface CourrielRecu {
  de: string;
  a: string[];
  donnees: string;
  /** En-têtes décodés, minuscules, pour une assertion lisible. */
  entetes: Record<string, string>;
  corps: string;
  authentifie: string | null;
}

export interface OptionsServeur {
  /** Exiger AUTH avant MAIL FROM. */
  exigerAuth?: boolean;
  utilisateur?: string;
  motDePasse?: string;
  /** Annoncer AUTH LOGIN seulement, pour éprouver le repli. */
  seulementAuthLogin?: boolean;
  /** Réponse imposée à DATA final : simule un refus. */
  refuserMessage?: { code: number; texte: string };
  /** Couper la connexion après cette commande, pour éprouver la reprise. */
  couperApres?: string;
}

export class ServeurSmtpTest {
  private serveur: Server | null = null;

  readonly recus: CourrielRecu[] = [];

  constructor(private readonly options: OptionsServeur = {}) {}

  /** Démarre sur un port libre choisi par le système, et le rend. */
  demarrer(): Promise<number> {
    return new Promise((resoudre, rejeter) => {
      this.serveur = createServer((prise) => this.dialoguer(prise));
      this.serveur.once('error', rejeter);
      // Port 0 : le système en choisit un libre. Un port fixe ferait échouer
      // les tests joués en parallèle, ou après un test qui a mal fermé.
      this.serveur.listen(0, '127.0.0.1', () => {
        const adresse = this.serveur!.address();
        if (typeof adresse === 'string' || adresse === null) {
          rejeter(new Error('Adresse de serveur inattendue'));
          return;
        }
        resoudre(adresse.port);
      });
    });
  }

  arreter(): Promise<void> {
    return new Promise((resoudre) => {
      if (!this.serveur) {
        resoudre();
        return;
      }
      this.serveur.close(() => resoudre());
      this.serveur = null;
    });
  }

  private dialoguer(prise: Socket): void {
    prise.setEncoding('utf8');

    let tampon = '';
    let de = '';
    let a: string[] = [];
    let enDonnees = false;
    let donnees = '';
    let authentifie: string | null = null;
    let attenteAuth: 'utilisateur' | 'motDePasse' | null = null;
    let utilisateurPropose = '';

    const repondre = (texte: string) => prise.write(texte + '\r\n');

    repondre('220 tontine-test ESMTP prêt');

    prise.on('data', (morceau: string) => {
      tampon += morceau;

      let fin: number;
      while ((fin = tampon.indexOf('\r\n')) !== -1) {
        const ligne = tampon.slice(0, fin);
        tampon = tampon.slice(fin + 2);

        if (enDonnees) {
          if (ligne === '.') {
            enDonnees = false;

            if (this.options.refuserMessage) {
              const { code, texte } = this.options.refuserMessage;
              repondre(`${code} ${texte}`);
              continue;
            }

            this.enregistrer(de, a, donnees, authentifie);
            donnees = '';
            repondre('250 2.0.0 Message accepté');
            continue;
          }

          // Dé-« stuffing » du point : le miroir exact de ce que fait le
          // client. Si le client oublie de doubler, le message sera tronqué
          // ici — et le test le verra.
          donnees += (ligne.startsWith('..') ? ligne.slice(1) : ligne) + '\n';
          continue;
        }

        const commande = ligne.split(' ')[0].toUpperCase();

        if (attenteAuth === 'utilisateur') {
          utilisateurPropose = Buffer.from(ligne, 'base64').toString('utf8');
          attenteAuth = 'motDePasse';
          repondre('334 UGFzc3dvcmQ6');
          continue;
        }

        if (attenteAuth === 'motDePasse') {
          const mot = Buffer.from(ligne, 'base64').toString('utf8');
          attenteAuth = null;
          if (
            utilisateurPropose === this.options.utilisateur &&
            mot === this.options.motDePasse
          ) {
            authentifie = utilisateurPropose;
            repondre('235 2.7.0 Authentification acceptée');
          } else {
            repondre('535 5.7.8 Identifiants refusés');
          }
          continue;
        }

        if (this.options.couperApres === commande) {
          prise.destroy();
          return;
        }

        switch (commande) {
          case 'EHLO': {
            // Réponse MULTI-LIGNES délibérée : c'est le cas que le client doit
            // savoir lire, et celui qui casse les implémentations naïves.
            const lignes = ['250-tontine-test vous salue', '250-PIPELINING'];
            if (this.options.exigerAuth || this.options.utilisateur) {
              lignes.push(
                this.options.seulementAuthLogin
                  ? '250-AUTH LOGIN'
                  : '250-AUTH PLAIN LOGIN',
              );
            }
            lignes.push('250 SIZE 10485760');
            prise.write(lignes.join('\r\n') + '\r\n');
            break;
          }

          case 'HELO':
            repondre('250 tontine-test vous salue');
            break;

          case 'AUTH': {
            const parties = ligne.split(' ');
            const mecanisme = (parties[1] ?? '').toUpperCase();

            if (mecanisme === 'PLAIN') {
              const jeton = Buffer.from(parties[2] ?? '', 'base64').toString(
                'utf8',
              );
              const [, utilisateur, mot] = jeton.split('\0');
              if (
                utilisateur === this.options.utilisateur &&
                mot === this.options.motDePasse
              ) {
                authentifie = utilisateur;
                repondre('235 2.7.0 Authentification acceptée');
              } else {
                repondre('535 5.7.8 Identifiants refusés');
              }
              break;
            }

            if (mecanisme === 'LOGIN') {
              attenteAuth = 'utilisateur';
              repondre('334 VXNlcm5hbWU6');
              break;
            }

            repondre('504 5.5.4 Mécanisme inconnu');
            break;
          }

          case 'MAIL':
            if (this.options.exigerAuth && !authentifie) {
              repondre('530 5.7.0 Authentification requise');
              break;
            }
            de = extraireAdresse(ligne);
            a = [];
            repondre('250 2.1.0 Expéditeur accepté');
            break;

          case 'RCPT': {
            const adresse = extraireAdresse(ligne);
            // Une adresse sans arobase est refusée DÉFINITIVEMENT : c'est le
            // cas d'un membre dont la fiche porte un numéro de téléphone dans
            // le champ courriel, et il doit produire un 5xx, pas un 4xx.
            if (!adresse.includes('@')) {
              repondre('550 5.1.3 Adresse invalide');
              break;
            }
            a.push(adresse);
            repondre('250 2.1.5 Destinataire accepté');
            break;
          }

          case 'DATA':
            if (a.length === 0) {
              repondre('503 5.5.1 Aucun destinataire');
              break;
            }
            enDonnees = true;
            donnees = '';
            repondre('354 Envoyez le message, terminez par <CRLF>.<CRLF>');
            break;

          case 'RSET':
            de = '';
            a = [];
            repondre('250 2.0.0 Réinitialisé');
            break;

          case 'QUIT':
            repondre('221 2.0.0 Au revoir');
            prise.end();
            return;

          default:
            repondre('502 5.5.2 Commande inconnue');
        }
      }
    });

    prise.on('error', () => {
      /* une coupure côté client est un cas de test, pas une panne */
    });
  }

  private enregistrer(
    de: string,
    a: string[],
    donnees: string,
    authentifie: string | null,
  ): void {
    const separation = donnees.indexOf('\n\n');
    const blocEntetes = separation === -1 ? donnees : donnees.slice(0, separation);
    const corps = separation === -1 ? '' : donnees.slice(separation + 2);

    const entetes: Record<string, string> = {};
    for (const ligne of blocEntetes.split('\n')) {
      const deuxPoints = ligne.indexOf(':');
      if (deuxPoints === -1) continue;
      entetes[ligne.slice(0, deuxPoints).toLowerCase()] = ligne
        .slice(deuxPoints + 1)
        .trim();
    }

    this.recus.push({
      de,
      a: [...a],
      donnees,
      entetes,
      corps: corps.replace(/\n$/, ''),
      authentifie,
    });
  }
}

function extraireAdresse(ligne: string): string {
  const entre = ligne.match(/<([^>]*)>/);
  return entre ? entre[1] : ligne.split(':')[1]?.trim() ?? '';
}

/**
 * Décode un en-tête encodé en mot MIME (RFC 2047), pour les assertions.
 *
 * Le test doit pouvoir affirmer « le sujet est *Rappel d'échéance* », pas
 * « le sujet est =?UTF-8?B?UmFwcGVs...?= » — sinon il vérifie l'encodage et
 * non le contenu.
 */
export function decoderEntete(valeur: string): string {
  return valeur.replace(
    /=\?UTF-8\?B\?([^?]+)\?=/gi,
    (_tout, base64: string) => Buffer.from(base64, 'base64').toString('utf8'),
  );
}

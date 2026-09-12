/**
 * Client SMTP minimal, écrit sur `node:net` et `node:tls`.
 *
 * POURQUOI PAS NODEMAILER. Le registre npm est injoignable depuis cet
 * environnement : `nodemailer` ne peut pas être installé, et livrer un
 * `package.json` qui le réclame rendrait le projet non démarrable ici. SMTP
 * (RFC 5321) est un protocole texte ligne à ligne ; ce dont une tontine a
 * besoin — se connecter, s'authentifier, poster un message — tient en deux
 * cents lignes qu'on peut lire et éprouver.
 *
 * CE QUE CE CLIENT NE FAIT PAS, et l'assume : pas de pièces jointes, pas de
 * multipart, pas de pool de connexions, pas de DKIM. Les rappels d'une tontine
 * sont du texte court envoyé quelques fois par jour. Une connexion par message
 * coûte une poignée de millisecondes et supprime toute gestion d'état partagé.
 *
 * CE QU'IL FAIT CORRECTEMENT, parce que s'en dispenser produirait des bogues
 * silencieux :
 *
 *   — Les réponses multi-lignes. Un serveur répond « 250-PIPELINING » puis
 *     « 250 SIZE » ; lire la première ligne et conclure ferait désynchroniser
 *     tout le dialogue à partir d'EHLO. Le tiret en quatrième position
 *     distingue la continuation de la fin (RFC 5321 §4.2.1).
 *
 *   — Le « byte stuffing » du point. Une ligne du corps réduite à « . »
 *     terminerait le message par le milieu. La RFC impose de doubler le point
 *     initial ; c'est un cas rare, et c'est exactement pourquoi il casse en
 *     production plutôt qu'en test.
 *
 *   — Les fins de ligne CRLF. Un corps composé en SQL avec des \n simples est
 *     accepté par les serveurs indulgents et rejeté par les autres.
 *
 *   — L'encodage du sujet. « Rappel d'échéance » en en-tête brut est illégal
 *     hors ASCII ; encodé en mot MIME base64 (RFC 2047), il s'affiche partout.
 */
import { createConnection, type Socket } from 'node:net';
import { connect as connecterTls } from 'node:tls';

export interface ConfigurationSmtp {
  hote: string;
  port: number;
  /** TLS dès la connexion (port 465). Sinon STARTTLS si le serveur l'annonce. */
  tlsImplicite: boolean;
  utilisateur?: string;
  motDePasse?: string;
  expediteur: string;
  /** Nom annoncé à EHLO. Certains serveurs refusent un client anonyme. */
  nomClient: string;
  delaiMs: number;
  /**
   * Autorise un certificat non vérifiable — pour un serveur de test local
   * uniquement. En production, laisser à `false` : un certificat invalide sur
   * une passerelle de messagerie est un signal, pas une gêne.
   */
  accepterCertificatInvalide: boolean;
}

export interface Courriel {
  destinataire: string;
  objet: string;
  corps: string;
}

interface Reponse {
  code: number;
  lignes: string[];
}

/** Erreur portant le code SMTP, pour distinguer un refus temporaire (4xx)
 *  d'un refus définitif (5xx) — le premier mérite un nouvel essai. */
export class ErreurSmtp extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly definitive: boolean,
  ) {
    super(message);
    this.name = 'ErreurSmtp';
  }
}

/**
 * Dialogue SMTP sur une connexion, ligne à ligne.
 *
 * La classe est volontairement jetable : une instance vaut pour une connexion,
 * et `fermer()` la rend inutilisable. Cela supprime la question « cette
 * connexion est-elle encore dans un état connu ? », qui est la source de la
 * plupart des bogues d'un client SMTP réutilisé.
 */
class Session {
  private tampon = '';
  private enAttente: ((reponse: Reponse) => void) | null = null;
  private enErreur: ((erreur: Error) => void) | null = null;
  private erreurFatale: Error | null = null;

  constructor(
    private prise: Socket,
    private readonly delaiMs: number,
  ) {
    this.brancher(prise);
  }

  private brancher(prise: Socket): void {
    prise.setEncoding('utf8');
    prise.on('data', (morceau: string) => this.recevoir(morceau));
    prise.on('error', (erreur: Error) => this.abandonner(erreur));
    prise.on('close', () =>
      this.abandonner(new Error('Connexion fermée par le serveur')),
    );
  }

  private abandonner(erreur: Error): void {
    // La PREMIÈRE erreur est la vraie. Une rupture de connexion déclenche
    // souvent « error » puis « close » ; garder la seconde masquerait le motif.
    this.erreurFatale ??= erreur;
    const rejeter = this.enErreur;
    this.enAttente = null;
    this.enErreur = null;
    rejeter?.(this.erreurFatale);
  }

  private recevoir(morceau: string): void {
    this.tampon += morceau;
    this.essayerDeRendre();
  }

  /** Lit une réponse complète, tirets de continuation compris. */
  lire(): Promise<Reponse> {
    if (this.erreurFatale) return Promise.reject(this.erreurFatale);

    return new Promise<Reponse>((resoudre, rejeter) => {
      const minuteur = setTimeout(() => {
        this.enAttente = null;
        this.enErreur = null;
        rejeter(
          new Error(`Le serveur SMTP n'a pas répondu en ${this.delaiMs} ms`),
        );
      }, this.delaiMs);

      const fini = (reponse: Reponse) => {
        clearTimeout(minuteur);
        resoudre(reponse);
      };
      const rate = (erreur: Error) => {
        clearTimeout(minuteur);
        rejeter(erreur);
      };

      this.enAttente = fini;
      this.enErreur = rate;
      this.essayerDeRendre();
    });
  }

  /**
   * Extrait du tampon une réponse complète si elle s'y trouve déjà.
   *
   * NE CONSOMME RIEN SANS LECTEUR EN ATTENTE. Le serveur envoie son accueil
   * « 220 ... » dès la connexion, souvent AVANT le premier `lire()`. Consommer
   * le tampon à ce moment ferait disparaître l'accueil, et le dialogue
   * entier se décalerait d'une réponse — EHLO lirait le code du MAIL FROM.
   * Le tampon est donc laissé intact, et `lire()` rappelle cette méthode.
   *
   * Une réponse est complète quand une ligne ne porte PAS de tiret en
   * quatrième position : « 250-PIPELINING » continue, « 250 SIZE » conclut
   * (RFC 5321 §4.2.1).
   */
  private essayerDeRendre(): void {
    if (!this.enAttente) return;

    const lignes: string[] = [];
    let reste = this.tampon;

    while (true) {
      const fin = reste.indexOf('\r\n');
      if (fin === -1) return; // incomplet : on attend d'autres octets

      const ligne = reste.slice(0, fin);
      lignes.push(ligne);
      reste = reste.slice(fin + 2);

      if (ligne.length < 4 || ligne[3] !== '-') {
        this.tampon = reste;
        const rendre = this.enAttente;
        this.enAttente = null;
        this.enErreur = null;
        rendre(this.analyser(lignes.join('\r\n')));
        return;
      }
    }
  }

  private analyser(brut: string): Reponse {
    const lignes = brut.split('\r\n').filter((l) => l.length > 0);
    const code = Number.parseInt(lignes[lignes.length - 1]?.slice(0, 3) ?? '0', 10);
    return { code, lignes };
  }

  ecrire(texte: string): void {
    if (this.erreurFatale) throw this.erreurFatale;
    this.prise.write(texte);
  }

  /** Envoie une commande et lit la réponse, en exigeant un code attendu. */
  async commander(commande: string, codesAcceptes: number[]): Promise<Reponse> {
    this.ecrire(commande + '\r\n');
    const reponse = await this.lire();

    if (!codesAcceptes.includes(reponse.code)) {
      // Le mot de passe ne doit JAMAIS apparaître dans un message d'erreur, et
      // donc jamais dans les journaux ni dans `derniere_erreur` en base.
      const visible = commande.startsWith('AUTH') || /^[A-Za-z0-9+/=]+$/.test(commande)
        ? '<données d\'authentification masquées>'
        : commande;

      throw new ErreurSmtp(
        `SMTP a refusé « ${visible} » : ${reponse.lignes.join(' | ')}`,
        reponse.code,
        reponse.code >= 500,
      );
    }

    return reponse;
  }

  remplacerPrise(prise: Socket): void {
    this.prise.removeAllListeners();
    this.prise = prise;
    this.tampon = '';
    this.brancher(prise);
  }

  priseCourante(): Socket {
    return this.prise;
  }

  fermer(): void {
    this.prise.removeAllListeners('close');
    this.prise.destroy();
  }
}

/**
 * Encode un en-tête en mot MIME si nécessaire (RFC 2047).
 *
 * On n'encode QUE si la chaîne sort de l'ASCII : un sujet anglais reste lisible
 * dans les journaux du serveur, ce qui aide au diagnostic. Un sujet français
 * — et ils le sont tous ici — est encodé en base64.
 */
export function encoderEntete(valeur: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(valeur)) return valeur;
  return `=?UTF-8?B?${Buffer.from(valeur, 'utf8').toString('base64')}?=`;
}

/**
 * Prépare un corps pour la commande DATA.
 *
 * Deux transformations, et chacune évite une classe de panne :
 * les fins de ligne deviennent CRLF (les serveurs stricts rejettent \n seul),
 * et un point en début de ligne est doublé (sinon il termine le message).
 */
export function preparerCorps(corps: string): string {
  return corps
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '\r\n')
    .replace(/^\./gm, '..');
}

function adresseSeule(valeur: string): string {
  const entre = valeur.match(/<([^>]+)>/);
  return entre ? entre[1] : valeur.trim();
}

/** Ouvre une connexion, en TLS direct ou en clair. */
function ouvrir(config: ConfigurationSmtp): Promise<Socket> {
  return new Promise((resoudre, rejeter) => {
    const surErreur = (erreur: Error) => {
      rejeter(
        new Error(
          `Connexion à ${config.hote}:${config.port} impossible — ${erreur.message}`,
        ),
      );
    };

    const prise = config.tlsImplicite
      ? connecterTls({
          host: config.hote,
          port: config.port,
          rejectUnauthorized: !config.accepterCertificatInvalide,
        })
      : createConnection({ host: config.hote, port: config.port });

    const evenement = config.tlsImplicite ? 'secureConnect' : 'connect';
    prise.setTimeout(config.delaiMs);
    prise.once('timeout', () =>
      surErreur(new Error(`délai de ${config.delaiMs} ms dépassé`)),
    );
    prise.once('error', surErreur);
    prise.once(evenement, () => {
      prise.setTimeout(0);
      prise.removeListener('error', surErreur);
      resoudre(prise as Socket);
    });
  });
}

/** Hisse une connexion en clair vers TLS (STARTTLS). */
function hisserTls(prise: Socket, config: ConfigurationSmtp): Promise<Socket> {
  return new Promise((resoudre, rejeter) => {
    const securisee = connecterTls({
      socket: prise,
      servername: config.hote,
      rejectUnauthorized: !config.accepterCertificatInvalide,
    });
    securisee.once('error', (erreur: Error) =>
      rejeter(new Error(`STARTTLS a échoué — ${erreur.message}`)),
    );
    securisee.once('secureConnect', () => resoudre(securisee as unknown as Socket));
  });
}

/**
 * Envoie un courriel. Une connexion, un message, puis QUIT.
 *
 * La séquence suit la RFC : accueil, EHLO, éventuellement STARTTLS puis un
 * second EHLO (les extensions annoncées en clair ne valent plus après
 * chiffrement), authentification, enveloppe, données.
 */
export async function envoyerCourriel(
  config: ConfigurationSmtp,
  courriel: Courriel,
): Promise<void> {
  const prise = await ouvrir(config);
  const session = new Session(prise, config.delaiMs);

  try {
    const accueil = await session.lire();
    if (accueil.code !== 220) {
      throw new ErreurSmtp(
        `Accueil SMTP inattendu : ${accueil.lignes.join(' | ')}`,
        accueil.code,
        accueil.code >= 500,
      );
    }

    let extensions = await session.commander(`EHLO ${config.nomClient}`, [250]);

    if (!config.tlsImplicite && annonce(extensions, 'STARTTLS')) {
      await session.commander('STARTTLS', [220]);
      session.remplacerPrise(await hisserTls(session.priseCourante(), config));
      // Second EHLO OBLIGATOIRE : les extensions annoncées avant chiffrement
      // sont périmées, et AUTH n'est souvent proposé qu'après STARTTLS.
      extensions = await session.commander(`EHLO ${config.nomClient}`, [250]);
    }

    if (config.utilisateur && config.motDePasse) {
      await authentifier(session, extensions, config);
    }

    await session.commander(
      `MAIL FROM:<${adresseSeule(config.expediteur)}>`,
      [250],
    );
    await session.commander(
      `RCPT TO:<${adresseSeule(courriel.destinataire)}>`,
      [250, 251],
    );
    await session.commander('DATA', [354]);

    session.ecrire(composer(config, courriel));
    const accepte = await session.lire();
    if (accepte.code !== 250) {
      throw new ErreurSmtp(
        `Message refusé : ${accepte.lignes.join(' | ')}`,
        accepte.code,
        accepte.code >= 500,
      );
    }

    // QUIT est poli mais pas critique : si le serveur a accepté le message, il
    // est parti. Une erreur ici ne doit pas faire croire à un échec d'envoi.
    try {
      await session.commander('QUIT', [221]);
    } catch {
      /* le message est accepté ; le reste est de la courtoisie */
    }
  } finally {
    session.fermer();
  }
}

function annonce(reponse: Reponse, extension: string): boolean {
  return reponse.lignes.some((ligne) =>
    ligne.slice(4).toUpperCase().startsWith(extension.toUpperCase()),
  );
}

/**
 * S'authentifie, en préférant PLAIN à LOGIN.
 *
 * PLAIN tient en une commande, LOGIN en trois allers-retours. On garde LOGIN en
 * repli parce que certains serveurs d'hébergeurs ne proposent que lui.
 */
async function authentifier(
  session: Session,
  extensions: Reponse,
  config: ConfigurationSmtp,
): Promise<void> {
  const ligneAuth = extensions.lignes
    .map((l) => l.slice(4))
    .find((l) => l.toUpperCase().startsWith('AUTH'));
  const mecanismes = (ligneAuth ?? '').toUpperCase();

  const utilisateur = config.utilisateur!;
  const motDePasse = config.motDePasse!;

  if (mecanismes.includes('PLAIN') || !ligneAuth) {
    const jeton = Buffer.from(
      `\0${utilisateur}\0${motDePasse}`,
      'utf8',
    ).toString('base64');
    await session.commander(`AUTH PLAIN ${jeton}`, [235]);
    return;
  }

  if (mecanismes.includes('LOGIN')) {
    await session.commander('AUTH LOGIN', [334]);
    await session.commander(
      Buffer.from(utilisateur, 'utf8').toString('base64'),
      [334],
    );
    await session.commander(
      Buffer.from(motDePasse, 'utf8').toString('base64'),
      [235],
    );
    return;
  }

  throw new ErreurSmtp(
    `Aucun mécanisme d'authentification commun (serveur : ${ligneAuth ?? 'aucun'})`,
    530,
    true,
  );
}

/** Compose le message complet : en-têtes, ligne vide, corps, point final. */
function composer(config: ConfigurationSmtp, courriel: Courriel): string {
  const entetes = [
    `From: ${config.expediteur}`,
    `To: ${courriel.destinataire}`,
    `Subject: ${encoderEntete(courriel.objet)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${config.nomClient}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    // 8bit plutôt que base64 : le corps reste lisible dans les journaux du
    // serveur, ce qui vaut beaucoup quand on diagnostique à distance.
    'Content-Transfer-Encoding: 8bit',
  ];

  return (
    entetes.join('\r\n') +
    '\r\n\r\n' +
    preparerCorps(courriel.corps) +
    '\r\n.\r\n'
  );
}

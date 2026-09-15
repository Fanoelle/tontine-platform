/**
 * Service Worker — ce qui rend l'application ouvrable sans réseau.
 *
 * SANS LUI, LE CACHE DES DONNÉES NE SERVIRAIT À RIEN. Un trésorier hors ligne
 * qui ouvre la plateforme n'obtiendrait même pas la page : le navigateur
 * échouerait à charger index.html, et les réponses archivées dans
 * localStorage resteraient inaccessibles faute de code pour les lire.
 *
 * DEUX STRATÉGIES, ET LA DISTINCTION EST LA SEULE CHOSE QUI COMPTE ICI.
 *
 *   — La COQUILLE (html, css, js) est servie depuis le cache d'abord. Elle
 *     change à chaque déploiement, jamais entre deux. La servir depuis le
 *     réseau ferait attendre l'utilisateur pour un fichier qu'on a déjà.
 *
 *   — L'API n'est JAMAIS servie depuis ce cache. Les montants, les impayés,
 *     les soldes passent par `appel()` dans app.js, qui les archive avec leur
 *     horodatage et affiche leur âge. Un Service Worker qui rendrait
 *     silencieusement une réponse d'API vieille d'une heure ferait annoncer au
 *     groupe un solde faux, sans que rien ne le signale.
 *
 * C'est pour cette raison que `/api/` est exclu explicitement plus bas, et
 * c'est la ligne la plus importante de ce fichier.
 */

// LA VERSION EST DANS LE NOM DU CACHE. La changer suffit à invalider
// l'ancienne coquille : `activate` supprime tout cache dont le nom diffère.
// Sans cela, un utilisateur garderait indéfiniment la version qu'il a d'abord
// chargée — le défaut classique d'un Service Worker mal repris.
const VERSION = 'tontine-v2';

/* LES MODULES D'ÉCRAN SONT DANS LA COQUILLE, ET C'EST LE POINT DÉLICAT DU
   DÉCOUPAGE.

   Depuis que les écrans lourds ou exclusifs sont chargés à la demande, un
   trésorier hors ligne qui ouvre un onglet jamais visité déclencherait un
   `import()` vers un fichier absent du cache — et verrait un écran d'erreur
   là où, avant le découpage, tout était déjà là.

   On les met donc TOUS en cache à l'installation. Le gain du découpage n'en
   est pas perdu : il porte sur ce que le NAVIGATEUR PARSE ET EXÉCUTE au
   premier affichage, pas sur ce que le Service Worker archive en arrière-plan
   pour plus tard. Le premier coûte à chaque visite ; le second une fois.

   Conséquence assumée : ajouter un module d'écran sans l'inscrire ici le rend
   indisponible hors ligne. `scripts/verifier-modules.py` le détecte. */
const COQUILLE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/ecran-import.js',
  '/ecrans-rosca.js',
  '/ecrans-asca.js',
  '/ecrans-mutuelle.js',
  '/ecrans-bureau.js',
];

self.addEventListener('install', (evenement) => {
  evenement.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(COQUILLE))
      // `skipWaiting` active la nouvelle version sans attendre la fermeture de
      // tous les onglets. Pour une application de consultation, recevoir la
      // correction tout de suite vaut mieux que la cohérence entre deux onglets
      // qu'on n'ouvre de toute façon presque jamais.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (evenement) => {
  evenement.waitUntil(
    caches
      .keys()
      .then((noms) =>
        Promise.all(
          noms
            .filter((nom) => nom !== VERSION)
            .map((nom) => caches.delete(nom)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (evenement) => {
  const requete = evenement.request;

  // Seules les lectures sont interceptées. Un POST doit atteindre le serveur
  // ou échouer franchement — c'est `appel()` qui traduit alors l'échec en
  // « la saisie est impossible hors ligne ».
  if (requete.method !== 'GET') return;

  const url = new URL(requete.url);

  // On ne touche pas aux autres origines.
  if (url.origin !== self.location.origin) return;

  // L'API PASSE DIRECTEMENT AU RÉSEAU, toujours. Voir l'en-tête de ce fichier :
  // une réponse d'API servie depuis ce cache serait indatable et indétectable
  // côté application. La fraîcheur des données est gérée par `appel()`, qui
  // sait dire de quand elles datent.
  if (url.pathname.startsWith('/api/')) return;

  evenement.respondWith(
    caches.match(requete).then((enCache) => {
      if (enCache) {
        // Servi depuis le cache, ET rafraîchi en arrière-plan : au prochain
        // chargement, l'utilisateur aura la version à jour sans avoir jamais
        // attendu.
        evenement.waitUntil(rafraichir(requete));
        return enCache;
      }

      return fetch(requete)
        .then((reponse) => {
          if (reponse && reponse.ok) {
            const copie = reponse.clone();
            evenement.waitUntil(
              caches.open(VERSION).then((cache) => cache.put(requete, copie)),
            );
          }
          return reponse;
        })
        .catch(() =>
          // Hors ligne et rien en cache : pour une navigation, on rend la page
          // d'accueil — l'application saura afficher son propre message. Rendre
          // l'erreur brute du navigateur laisserait l'utilisateur devant un
          // écran de panne sans rapport avec ce qu'il faisait.
          requete.mode === 'navigate'
            ? caches.match('/index.html')
            : Response.error(),
        );
    }),
  );
});

function rafraichir(requete) {
  return fetch(requete)
    .then((reponse) => {
      if (!reponse || !reponse.ok) return;
      return caches.open(VERSION).then((cache) => cache.put(requete, reponse));
    })
    .catch(() => {
      /* hors ligne : la version en cache reste la bonne */
    });
}

const VERSION = 'tontine-v1';
const COQUILLE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
];
self.addEventListener('install', (evenement) => {
  evenement.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(COQUILLE))
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
  if (requete.method !== 'GET') return;
  const url = new URL(requete.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  evenement.respondWith(
    caches.match(requete).then((enCache) => {
      if (enCache) {
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
    });
}
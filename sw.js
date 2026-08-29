// sw.js
// Mise en cache volontairement minimale : seulement les fichiers statiques
// (structure, style, logique, icônes). Les données réelles (produits,
// panier, commandes, paiement) passent TOUJOURS par le réseau — jamais
// servies depuis le cache, pour ne jamais afficher de stock/prix/statut
// périmé au client.

const CACHE_NOM = 'camertech-cache-v1';
const FICHIERS_STATIQUES = [
    '/', '/index.html', '/style.css', '/script.js', '/config.js',
    '/logo.png', '/icon-192.png', '/icon-512.png', '/manifest.json'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NOM).then((cache) => cache.addAll(FICHIERS_STATIQUES))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((noms) =>
            Promise.all(noms.filter((n) => n !== CACHE_NOM).map((n) => caches.delete(n)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Jamais de cache pour les appels API, Supabase, ou les domaines
    // externes (paiement, images produits, polices, etc.) — uniquement
    // les fichiers statiques du site lui-même.
    if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then((reponseCache) => {
            const fetchReseau = fetch(event.request).then((reponseReseau) => {
                if (reponseReseau && reponseReseau.status === 200) {
                    const clone = reponseReseau.clone();
                    caches.open(CACHE_NOM).then((cache) => cache.put(event.request, clone));
                }
                return reponseReseau;
            }).catch(() => reponseCache);
            // Réseau prioritaire, cache seulement en secours (hors-ligne).
            return fetchReseau;
        })
    );
});

// ===== NOTIFICATIONS PUSH =====
self.addEventListener('push', (event) => {
    let donnees = {};
    try { donnees = event.data ? event.data.json() : {}; } catch (e) {}
    const titre = donnees.titre || 'CAMERTECH MARKET';
    event.waitUntil(
        self.registration.showNotification(titre, {
            body: donnees.corps || '',
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            data: { url: donnees.url || '/' }
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url || '/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window' }).then((clientsArr) => {
            const dejaOuvert = clientsArr.find((c) => c.url.includes(self.location.origin));
            if (dejaOuvert) return dejaOuvert.focus();
            return self.clients.openWindow(url);
        })
    );
});

// ===== INIT SUPABASE =====
const db = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// Remplace les fenêtres natives du navigateur ("le site indique...")
// par une notification stylisée cohérente avec le design du site.
// type: 'succes' | 'erreur' | 'info'
function notifier(message, type = 'info') {
    let conteneur = document.getElementById('toast-conteneur');
    if (!conteneur) {
        conteneur = document.createElement('div');
        conteneur.id = 'toast-conteneur';
        document.body.appendChild(conteneur);
    }
    const icones = { succes: '✅', erreur: '❌', info: 'ℹ️' };
    // Le message contient parfois déjà son propre emoji (❌/✅/😕/⏳/🔍) — on
    // évite de le doubler avec l'icône de la pastille.
    const dejaIcone = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(message.trim());
    const duree = Math.min(9000, Math.max(3500, message.length * 65));

    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.innerHTML = `${dejaIcone ? '' : `<span class="toast-icone">${icones[type] || icones.info}</span>`}
        <span class="toast-msg"></span>
        <button class="toast-fermer" aria-label="Fermer">✕</button>
        <span class="toast-barre" style="animation-duration:${duree}ms"></span>`;
    toast.querySelector('.toast-msg').textContent = message; // textContent : jamais d'injection HTML
    conteneur.appendChild(toast);

    const retirer = () => {
        toast.style.animation = 'toastSortie 0.22s ease forwards';
        setTimeout(() => toast.remove(), 220);
    };
    toast.querySelector('.toast-fermer').onclick = retirer;
    setTimeout(retirer, duree);
}

// Filet de sécurité global : si une erreur JavaScript imprévue survient
// n'importe où sur le site (bug non anticipé, script tiers, etc.), le
// visiteur ne doit JAMAIS voir le message technique brut (trace d'appel,
// nom de fichier, détail interne) — seulement un message générique dans le
// style du site. Le détail réel reste dans la console pour le diagnostic.
// Un compteur limite à 1 toast affiché par minute pour ne pas spammer
// l'écran si plusieurs erreurs surviennent en cascade.
let _derniereAlerteErreurGlobale = 0;
function _signalerErreurInattendue(source, detail) {
    console.error('[Erreur inattendue]', source, detail);
    const maintenant = Date.now();
    if (maintenant - _derniereAlerteErreurGlobale < 60000) return;
    _derniereAlerteErreurGlobale = maintenant;
    notifier("😕 Une erreur inattendue s'est produite. Réessaie, ou contacte-nous si ça persiste.", 'erreur');
}
window.addEventListener('error', (e) => _signalerErreurInattendue('window.onerror', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => _signalerErreurInattendue('promesse non gérée', e.reason));

// ===== TRACKING VISITEURS (anonyme, sans identité forcée) =====
// Identifiant aléatoire (pas de nom, pas d'email tant que le visiteur ne
// s'identifie pas lui-même en créant un compte). Écriture seule côté
// navigateur : les tables visiteurs_sessions/visiteurs_evenements sont
// verrouillées en lecture (voir supabase_visiteurs.sql) — un visiteur ne
// peut jamais lire les données d'un autre, ni même les siennes, via l'API.
const visiteurId = (() => {
    let id = localStorage.getItem('cmkt_visiteur_id');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('cmkt_visiteur_id', id); }
    return id;
})();

let _pageActuelle = null, _pageDebut = null;
const _produitsDejaVus = new Set();

function logVisiteur(type, cible, meta, duree_secondes) {
    // "Fire and forget" : le tracking ne doit jamais bloquer ni casser
    // l'expérience du site, donc on avale silencieusement les erreurs.
    try {
        db.from('visiteurs_evenements').insert([{ session_id: visiteurId, type, cible: cible||null, meta: meta||null, duree_secondes: duree_secondes||null }]).then(()=>{}, ()=>{});
    } catch (e) {}
}

function _terminerPageActuelle() {
    if (!_pageActuelle) return;
    const duree = Math.round((Date.now() - _pageDebut) / 1000);
    if (duree > 1) logVisiteur('page_view', _pageActuelle, null, duree);
}

function logPageVue(page) {
    _terminerPageActuelle();
    _pageActuelle = page || location.pathname;
    _pageDebut = Date.now();
}

// Enregistre la session du visiteur par le serveur (le navigateur n'écrit plus dans visiteurs_sessions).
// Avec `avecJeton`, la connexion du client est vérifiée par le serveur, qui relie alors la session à son compte.
async function enregistrerSessionVisiteur(avecJeton) {
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (avecJeton) { const u = await attendreFirebaseUser(); if (u) headers['Authorization'] = 'Bearer ' + await u.getIdToken(); }
        const p = new URLSearchParams(location.search);
        await fetch('/api/preparer-paiement', {
            method: 'POST', headers, keepalive: true,
            body: JSON.stringify({ visite: { session_id: visiteurId, user_agent: navigator.userAgent, referrer: document.referrer || null,
                utm_source: p.get('utm_source'), utm_medium: p.get('utm_medium'), utm_campaign: p.get('utm_campaign') } })
        });
    } catch (e) {}
}

async function initTrackingVisiteur() {
    enregistrerSessionVisiteur(false);   // le serveur crée / met à jour la session (sans bloquer la page)
    logPageVue(location.pathname);

    // Enregistre la durée de la page en cours dès que le visiteur quitte/
    // change d'onglet — sendBeacon fonctionne même pendant la fermeture de
    // la page (contrairement à un fetch classique).
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') _envoyerDureeBeacon();
    });
    window.addEventListener('pagehide', _envoyerDureeBeacon);
}

function _envoyerDureeBeacon() {
    if (!_pageActuelle) return;
    const duree = Math.round((Date.now() - _pageDebut) / 1000);
    if (duree < 2) return;
    const url = `${CONFIG.SUPABASE_URL}/rest/v1/visiteurs_evenements`;
    try {
        // fetch(..., {keepalive:true}) plutôt que navigator.sendBeacon() :
        // sendBeacon envoie parfois les cookies même en cross-origin, ce qui
        // entre en conflit avec l'en-tête CORS "Access-Control-Allow-Origin: *"
        // de Supabase (un navigateur bloque cette combinaison) — la requête
        // échouait silencieusement (net::ERR_FAILED). keepalive:true garantit
        // le même comportement utile (la requête part même si la page se ferme).
        fetch(url, {
            method: 'POST', keepalive: true, credentials: 'omit',
            headers: { 'Content-Type': 'application/json', 'apikey': CONFIG.SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + CONFIG.SUPABASE_ANON_KEY },
            body: JSON.stringify({ session_id: visiteurId, type: 'page_view', cible: _pageActuelle, duree_secondes: duree })
        }).catch(() => {});
    } catch (e) {}
}

// Relie la session anonyme au profil dès qu'un visiteur se connecte ou crée
// un compte — légitime puisqu'il s'identifie lui-même à ce moment précis.
function lierSessionVisiteur() {
    if (!currentUser) return;
    enregistrerSessionVisiteur(true);
}

// Repère les produits qui apparaissent réellement à l'écran (pas juste
// "présents dans le DOM") — un produit tout en bas d'une grille jamais
// scrollée ne compte pas comme "vu".
const _observateurImpressions = new IntersectionObserver((entrees) => {
    entrees.forEach(entree => {
        if (!entree.isIntersecting) return;
        const id = entree.target.dataset.trackId;
        if (id && !_produitsDejaVus.has(id)) {
            _produitsDejaVus.add(id);
            logVisiteur('produit_impression', id, { nom: entree.target.dataset.trackNom });
        }
    });
}, { threshold: 0.5 });


// ===== ÉTAT =====
let currentUser = null;
let favorisIds = new Set();
let allProducts = [], panier = [], modalProduct = null;

// Échappe le HTML avant d'injecter du texte fourni par un utilisateur (avis
// clients, nom d'invité, etc.) dans un innerHTML — sans ça, un commentaire
// piégé s'exécute comme du vrai code dans le navigateur de quiconque le lit,
// y compris l'admin (faille XSS stockée corrigée en session).
// Replie l'en-tête (bandeau Flash Combo, astuce photo, catégories, nom du
// logo) quand on défile vers le bas sur mobile, pour laisser plus de place
// aux produits à l'écran — se redéploie en remontant ou en touchant la loupe.
//
// Anti-saccades : la hauteur de .header dans la page est gelée (--header-h),
// donc replier/déplier ne déplace jamais le contenu (c'était la cause de la
// boucle « replie → la page bouge → redéploie → ... » et du lag). Le script
// de défilement est aussi regroupé par image (requestAnimationFrame).
(() => {
    const header = document.querySelector('.header');
    const interieur = header && header.querySelector('.header-inner');
    if (!header || !interieur) return;
    const mobile = window.matchMedia('(max-width: 640px)');
    const H_COMPACT = 56;      // hauteur approximative de l'en-tête replié (px)
    const MONTEE_MIN = 14;     // px à remonter avant de redéployer (anti-rebond)
    let hauteurComplete = 0, enCompact = false, dernierY = window.scrollY;
    let monteeCumulee = 0, enAttente = false, verrouJusqua = 0;
    window._enteteEnMouvement = false;

    const barreRecherche = () => document.getElementById('search-bar');

    // Mesure l'en-tête COMPLET (jamais pendant le repliage ni une animation)
    function mesurer() {
        if (!mobile.matches) { header.style.removeProperty('--header-h'); hauteurComplete = 0; return; }
        if (enCompact || Date.now() < verrouJusqua) return;
        const h = Math.ceil(interieur.getBoundingClientRect().height);
        if (h > 0 && h !== hauteurComplete) {
            hauteurComplete = h;
            header.style.setProperty('--header-h', h + 'px');
        }
    }

    function appliquer(etat) {
        if (etat === enCompact) return;
        enCompact = etat;
        header.classList.toggle('compact', etat);
        verrouJusqua = Date.now() + 350;
        window._enteteEnMouvement = true;   // le slider attend la fin du mouvement
        setTimeout(() => { window._enteteEnMouvement = false; mesurer(); }, 350);
    }

    // On ne replie qu'une fois la zone « réservée » de l'en-tête sortie de
    // l'écran, sinon une bande vide apparaîtrait sous l'en-tête replié.
    const seuilReplier = () => Math.max(60, hauteurComplete - H_COMPACT);

    function evaluer() {
        enAttente = false;
        if (!mobile.matches) { appliquer(false); dernierY = window.scrollY; return; }
        // Ignore les rebonds élastiques (au-delà du haut ou du bas de page)
        const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const y = Math.min(Math.max(window.scrollY, 0), maxY);
        const delta = y - dernierY;
        dernierY = y;
        // Clavier ouvert / saisie en cours : l'en-tête reste complet
        if (document.activeElement === barreRecherche()) { appliquer(false); return; }
        if (y <= seuilReplier()) { monteeCumulee = 0; appliquer(false); return; }
        if (delta > 1) { monteeCumulee = 0; appliquer(true); }
        else if (delta < 0) {
            monteeCumulee += -delta;
            if (monteeCumulee >= MONTEE_MIN) appliquer(false);
        }
    }

    window.addEventListener('scroll', () => {
        if (enAttente) return;
        enAttente = true;
        requestAnimationFrame(evaluer);
    }, { passive: true });

    // Re-mesure quand la taille de l'en-tête change (bandeau Flash Combo qui
    // apparaît, polices chargées, rotation d'écran, changement de langue…)
    if ('ResizeObserver' in window) new ResizeObserver(mesurer).observe(interieur);
    window.addEventListener('resize', mesurer);
    window.addEventListener('orientationchange', () => setTimeout(mesurer, 300));
    window.addEventListener('load', mesurer);
    if (mobile.addEventListener) mobile.addEventListener('change', mesurer);
    mesurer();

    const btnCompact = document.getElementById('search-compact-btn');
    if (btnCompact) btnCompact.onclick = () => {
        appliquer(false);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        // Focus immédiat (geste tactile encore « valide » → le clavier s'ouvre)
        const champ = barreRecherche();
        if (champ) champ.focus({ preventScroll: true });
    };
})();

function echapperHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
let selectedFile = null, selectedFilesAll = [], editingId = null, currentCat = "tous";
let _requeteRecherche = '';   // texte tapé dans la barre de recherche (vide = pas de recherche en cours)
let userZone = "", fraisLivraison = 0;
let slideIndex = 0, slideTimer = null, totalSlides = 1;
let selectedNote = 0, avisFile = null;

// ===== COMPRESSION IMAGE =====
async function compresserImage(file, maxPx = 1000, qualite = 0.80) {
    return new Promise(res => {
        const reader = new FileReader();
        reader.onload = e => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let w = img.width, h = img.height;
                const max = maxPx;
                if (w > max || h > max) {
                    const r = Math.min(max/w, max/h);
                    w = Math.round(w*r); h = Math.round(h*r);
                }
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                canvas.toBlob(b => res(b), 'image/webp', qualite);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

async function uploadImage(file) {
    const blob = await compresserImage(file);
    const name = Date.now() + '-' + Math.random().toString(36).substring(2) + '.webp';
    const { data, error } = await db.storage.from(CONFIG.BUCKET).upload(name, blob, { contentType: 'image/webp', cacheControl: '31536000' });
    if (error) throw error;
    try {   // miniature 400 px à côté de la photo (non bloquant : sans elle, le site retombe sur la photo d'origine)
        const mini = await compresserImage(file, 400, 0.75);
        await db.storage.from(CONFIG.BUCKET).upload(name.replace(/\.webp$/, '_t.webp'), mini, { contentType: 'image/webp', cacheControl: '31536000' });
    } catch (e) {}
    return db.storage.from(CONFIG.BUCKET).getPublicUrl(data.path).data.publicUrl;
}

// Miniatures (400 px) : les cartes, le slider et les tuiles les affichent (~20 Ko au lieu de ~100 Ko par photo).
// L'administrateur les active (Paramètres > optimiser les images) une fois créées ; sans miniature, le navigateur retombe sur la photo d'origine.
window._miniatures = (() => { try { return localStorage.getItem('cmkt_miniatures') === '1'; } catch (e) { return false; } })();
function nomMiniature(url) {
    const m = /^(.*\/storage\/v1\/object\/public\/[^/]+\/)([^?#]+?)(\.(?:webp|jpe?g|png))(\?.*)?$/i.exec(String(url || ''));
    return (!m || /_t$/.test(m[2])) ? null : m[1] + m[2] + '_t.webp' + (m[4] || '');
}
function srcMini(url) { return (window._miniatures && nomMiniature(url)) || url; }

// ===== UTILITAIRES =====
const isNew = d => (new Date() - new Date(d)) < 7*24*60*60*1000;
const getPrix = p => prixCharme((p.promo_active || p.flash_active) && p.promo_prix ? p.promo_prix : p.resale_price);

// Prix psychologique / "charm pricing" : un prix qui tombe pile sur une
// centaine (5000, 12000, 800...) est affiché et facturé 1 FCFA en dessous
// (4999, 11999, 799...). Ne touche jamais aux prix déjà "cassés" par
// l'admin (ex: 4750 reste 4750) — uniquement les comptes ronds.
// Prix « charme » : sert UNIQUEMENT à l'AFFICHAGE des fiches produit (500 -> 499).
// Le serveur (api/preparer-paiement.js) encaisse toujours le prix réel de la base ;
// il n'utilise jamais ce calcul ni un prix envoyé par le navigateur.
function prixCharme(prix) {
    const p = Math.round(prix || 0);
    return (p > 0 && p % 100 === 0) ? p - 1 : p;
}

// ===== ADRESSE DE CHAQUE PRODUIT (/produit/<nom>-<id>) =====
// ⚠️ Ces règles existent AUSSI dans scripts/generer-pages.js (qui fabrique les pages
// produit à chaque déploiement) et DOIVENT rester identiques des deux côtés.
function idCourtProduit(id) {
    return String(id).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-8) || 'x';
}
function slugProduit(p) {
    const base = String(p.name || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' et ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
        .replace(/-+$/, '') || 'produit';
    return base + '-' + idCourtProduit(p.id);
}
// Produit désigné par l'adresse de la page (ex : /produit/powerbank-oraimo-27000-mah-3fa9c1d2), s'il existe.
function produitDepuisURL() {
    const m = window.location.pathname.match(/^\/produit\/([^\/]+)\/?$/);
    if (!m) return null;
    const court = m[1].split('-').pop();
    return allProducts.find(p => idCourtProduit(p.id) === court) || null;
}
// À l'arrivée sur /produit/..., ouvre la fiche du produit ; adresse inconnue : retour à l'accueil.
function ouvrirProduitDepuisURL() {
    if (window.location.pathname.indexOf('/produit/') !== 0) return;
    const p = produitDepuisURL();
    if (p) openModal(p.id);
    else window.history.replaceState(null, '', '/');
}
// Prix RÉELLEMENT encaissé = celui du serveur (api/preparer-paiement.js) : prix en
// base arrondi, SANS l'effet "charme". getPrix() ne sert qu'à l'AFFICHAGE des
// fiches produit (500 -> 499) ; le panier et l'écran de paiement montrent le vrai
// montant à payer pour que le client ne soit jamais surpris.
const prixReelProduit = p => Math.round(((p.promo_active || p.flash_active) && p.promo_prix ? p.promo_prix : p.resale_price) || 0);

// Prix réel d'une ligne de panier (anciens paniers sans prix_reel : on le retrouve
// dans le catalogue ou les combos chargés ; en dernier recours, le prix affiché).
function prixReelLigne(item) {
    if (!item) return 0;
    if (Number.isFinite(item.prix_reel)) return item.prix_reel;
    if (item.combo_id) {
        if (!item.prix) return 0; // article inclus dans un kit
        const o = (typeof flashCombosValides !== 'undefined' && flashCombosValides || []).find(x => x.id === item.combo_id);
        return o && Number.isFinite(o.prix_ensemble_reel) ? o.prix_ensemble_reel : item.prix;
    }
    const prod = (typeof allProducts !== 'undefined' && allProducts || []).find(x => x.id === item.id);
    return prod ? prixReelProduit(prod) : (item.prix || 0);
}
const fmt = n => parseInt(n).toLocaleString('fr-FR');
const $ = id => document.getElementById(id);

// ===== APPLICATION INSTALLABLE (PWA) =====
let evenementInstallPwa = null;

function setupPwa() {
    // Service worker : cache uniquement les fichiers statiques (jamais les
    // données produits/panier/commandes), pour un fonctionnement hors-ligne
    // partiel et une installation possible sur mobile.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});

        // Actualisation en direct : dès qu'une nouvelle version du site est
        // déployée et prend le relais, la page se recharge automatiquement
        // une seule fois pour afficher le contenu à jour — sans que le
        // client ait besoin de désinstaller/réinstaller quoi que ce soit.
        let dejaRecharge = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (dejaRecharge) return;
            dejaRecharge = true;
            window.location.reload();
        });
    }

    // Déjà installée (mode standalone) : pas besoin de proposer l'install.
    const dejaInstallee = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (dejaInstallee) return;

    // Android/Chrome : le navigateur nous prévient quand l'installation
    // est possible — on garde l'événement pour le déclencher nous-mêmes
    // au clic sur notre propre bouton (plus discret que le bandeau natif).
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        evenementInstallPwa = e;
        $('btn-install-pwa').style.display = 'flex';
    });

    $('btn-install-pwa').onclick = async () => {
        if (evenementInstallPwa) {
            evenementInstallPwa.prompt();
            const { outcome } = await evenementInstallPwa.userChoice;
            if (outcome === 'accepted') $('btn-install-pwa').style.display = 'none';
            evenementInstallPwa = null;
        } else {
            // iOS Safari ne déclenche jamais beforeinstallprompt — on
            // guide manuellement (seul moyen possible sur iPhone/iPad).
            notifier("Pour installer l'app sur iPhone/iPad :\n\n1. Appuie sur le bouton Partager (carré avec une flèche) en bas de Safari\n2. Choisis \"Sur l'écran d'accueil\"\n3. Confirme", 'info');
        }
    };

    // iOS : jamais d'événement natif, on affiche quand même le bouton (il
    // ouvrira les instructions manuelles ci-dessus).
    const estIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (estIOS) $('btn-install-pwa').style.display = 'flex';

    window.addEventListener('appinstalled', () => {
        $('btn-install-pwa').style.display = 'none';
        // Demande l'autorisation notifications juste après l'installation
        // (utile pour prévenir plus tard des changements de statut de
        // commande) — seulement si jamais demandée avant, et seulement
        // si le navigateur supporte l'API.
        if ('Notification' in window && Notification.permission === 'default') {
            setTimeout(async () => {
                const permission = await Notification.requestPermission().catch(() => 'denied');
                if (permission === 'granted') abonnerPushSiConnecte();
            }, 1200);
        }
    });

    // Si déjà autorisé (installation précédente) et déjà connecté, on
    // (ré)abonne silencieusement — utile après un changement d'appareil.
    if ('Notification' in window && Notification.permission === 'granted') {
        setTimeout(abonnerPushSiConnecte, 2000);
    }
}

// Convertit la clé VAPID publique (base64url) au format attendu par
// pushManager.subscribe (Uint8Array).
// Page de présentation dédiée (menu "Télécharger l'app"), avec un gros
// bouton d'action — réutilise la même mécanique d'installation que le
// petit bouton du header, juste avec plus de contexte pour l'utilisateur.
// Page de présentation dédiée (menu "Télécharger l'app" côté client, bouton
// "Installer l'app Admin" côté panneau admin) — réutilise la même mécanique
// d'installation que le petit bouton du header.
// Construite entièrement en JS (au lieu de s'appuyer sur le HTML statique
// #telecharger-app-overlay) car l'écran de connexion admin remplace tout
// document.body.innerHTML : le HTML statique n'existe plus une fois dans
// le panneau admin, donc l'ancienne version (basée sur $('...')) échouait
// silencieusement sans jamais afficher la fenêtre.
function ouvrirPresentationTelechargement() {
    const dejaInstallee = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const estIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const estAdmin = false;

    const nom = estAdmin ? 'KM Admin' : 'Kapmaket';
    const icone = estAdmin ? '/icon-admin-192.png' : '/icon-192.png';
    const degrade = estAdmin ? 'linear-gradient(135deg,#8e1c1c,#C62828 70%,#e35353)' : 'linear-gradient(135deg,var(--green-dark),var(--green) 70%,var(--green-light))';
    const sousTitre = estAdmin ? "Installe l'app admin pour une gestion plus rapide" : "Installe l'app pour une expérience plus rapide";

    const el = document.createElement('div');
    el.className = 'modal-overlay';
    el.style.display = 'flex';
    el.style.zIndex = '5000';
    el.innerHTML = `<div class="modal" style="max-width:420px;text-align:center;padding:0;overflow:hidden">
        <button class="modal-x" onclick="this.closest('.modal-overlay').remove()" style="z-index:5">✕</button>
        <div style="background:${degrade};padding:36px 24px 28px;color:white">
            <img src="${icone}" alt="Logo" style="width:76px;height:76px;border-radius:20px;box-shadow:0 8px 24px rgba(0,0,0,0.25);margin-bottom:14px">
            <h2 style="font-family:var(--font-title);font-size:1.3rem;margin:0">${nom}</h2>
            <p style="opacity:0.9;font-size:0.85rem;margin-top:4px">${sousTitre}</p>
        </div>
        <div style="padding:24px">
            <div style="text-align:left;display:flex;flex-direction:column;gap:14px;margin-bottom:22px">
                <div style="display:flex;gap:12px;align-items:start">
                    <span style="font-size:1.3rem">⚡</span>
                    <div><strong style="font-size:0.88rem">Plus rapide</strong><div style="color:var(--text3);font-size:0.78rem">Un raccourci direct sur ton écran d'accueil, sans passer par le navigateur.</div></div>
                </div>
                <div style="display:flex;gap:12px;align-items:start">
                    <span style="font-size:1.3rem">🔔</span>
                    <div><strong style="font-size:0.88rem">Alertes de commande</strong><div style="color:var(--text3);font-size:0.78rem">Sois prévenu dès que ta commande est confirmée ou livrée.</div></div>
                </div>
                <div style="display:flex;gap:12px;align-items:start">
                    <span style="font-size:1.3rem">📶</span>
                    <div><strong style="font-size:0.88rem">Fonctionne même hors ligne</strong><div style="color:var(--text3);font-size:0.78rem">Consulte le site même avec une connexion faible.</div></div>
                </div>
                <div style="display:flex;gap:12px;align-items:start">
                    <span style="font-size:1.3rem">🆓</span>
                    <div><strong style="font-size:0.88rem">100% gratuit</strong><div style="color:var(--text3);font-size:0.78rem">Aucun espace de stockage lourd, aucun paiement.</div></div>
                </div>
            </div>
            <button id="btn-telecharger-app-principal" style="width:100%;background:linear-gradient(135deg,var(--orange),var(--orange-light));color:white;border:none;padding:16px;border-radius:var(--radius-pill);font-weight:800;font-size:1rem;cursor:pointer;font-family:var(--font-title);letter-spacing:0.3px;box-shadow:0 8px 22px rgba(255,107,26,0.4);animation:pulseTelecharger 1.8s infinite">⬇️ Télécharger maintenant</button>
            <p id="telecharger-app-note" style="color:var(--text3);font-size:0.75rem;margin-top:12px"></p>
        </div>
    </div>`;
    document.body.appendChild(el);

    const btn = el.querySelector('#btn-telecharger-app-principal');
    const note = el.querySelector('#telecharger-app-note');

    if (dejaInstallee) {
        btn.style.display = 'none';
        note.textContent = "✅ L'app est déjà installée sur cet appareil !";
    } else {
        btn.style.display = 'block';
        note.textContent = estIOS ? 'Sur iPhone/iPad, Safari te guide pas à pas au clic.' : '';
        btn.onclick = async () => {
            if (evenementInstallPwa) {
                evenementInstallPwa.prompt();
                const { outcome } = await evenementInstallPwa.userChoice;
                if (outcome === 'accepted') { el.remove(); }
                evenementInstallPwa = null;
            } else if (estIOS) {
                notifier("Pour installer l'app sur iPhone/iPad :\n\n1. Appuie sur le bouton Partager (carré avec une flèche) en bas de Safari\n2. Choisis \"Sur l'écran d'accueil\"\n3. Confirme", 'info');
            } else {
                notifier("Ton navigateur ne propose pas encore l'installation automatique ici.\n\nSur Android/Chrome, essaie depuis le menu du navigateur (⋮) → \"Installer l'application\".", 'info');
            }
        };
    }
}

function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - base64.length % 4) % 4);
    const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64Safe);
    return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// Attend que Firebase ait fini de restaurer la session (asynchrone au
// chargement de la page) avant de renvoyer l'utilisateur Firebase réel —
// évite de planter en demandant un jeton avant que ce soit prêt.
function attendreFirebaseUser() {
    return new Promise((resolve) => {
        if (window.firebaseAuth?.currentUser) { resolve(window.firebaseAuth.currentUser); return; }
        const unsub = window.fbOnAuthStateChanged(window.firebaseAuth, (u) => {
            unsub();
            resolve(u);
        });
    });
}


async function abonnerPushSiConnecte() {
    if (!currentUser) return;
    if (Notification.permission !== 'granted') { console.log('Push: permission =', Notification.permission); return; }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { notifier('🔍 Diagnostic push : ce navigateur ne supporte pas les notifications push.', 'info'); return; }
    if (!CONFIG.VAPID_PUBLIC_KEY) { notifier('🔍 Diagnostic push : clé VAPID manquante côté site.', 'erreur'); return; }
    try {
        const fbUser = await attendreFirebaseUser();
        if (!fbUser) return; // vraiment déconnecté, rien à faire

        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY)
            });
        }
        const idToken = await fbUser.getIdToken();
        const resp = await fetch('/api/push-subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
            body: JSON.stringify({ subscription: sub.toJSON() })
        });
        if (!resp.ok) {
            const j = await resp.json().catch(()=>({}));
            notifier('🔍 Diagnostic push : le serveur a refusé l\'abonnement — ' + (j.error || resp.status), 'erreur');
        }
    } catch (e) {
        console.error('Erreur abonnement push:', e);
        notifier('🔍 Diagnostic push : ' + (e.message || e), 'erreur');
    }
}

// ===== AVATAR (Gravatar avec repli sur initiales colorées) =====
// Implémentation MD5 autonome (nécessaire pour construire l'URL Gravatar,
// qui exige un hash MD5 de l'email — aucune dépendance externe ajoutée).
function _md5(str) {
    function rotl(n, c) { return (n << c) | (n >>> (32 - c)); }
    function toHex(n) {
        let s = '', v;
        for (let i = 0; i < 4; i++) {
            v = (n >>> (i * 8)) & 255;
            s += (v < 16 ? '0' : '') + v.toString(16);
        }
        return s;
    }
    const K = [];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,
               5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,
               4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,
               6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c < 128) bytes.push(c);
        else if (c < 2048) { bytes.push((c >> 6) | 192, (c & 63) | 128); }
        else { bytes.push((c >> 12) | 224, ((c >> 6) & 63) | 128, (c & 63) | 128); }
    }
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 0; i < 8; i++) bytes.push((bitLen / Math.pow(2, i * 8)) & 255);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let chunk = 0; chunk < bytes.length; chunk += 64) {
        const M = [];
        for (let i = 0; i < 16; i++) {
            M[i] = bytes[chunk + i*4] | (bytes[chunk + i*4+1] << 8) | (bytes[chunk + i*4+2] << 16) | (bytes[chunk + i*4+3] << 24);
        }
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
            let F, g;
            if (i < 16) { F = (B & C) | (~B & D); g = i; }
            else if (i < 32) { F = (D & B) | (~D & C); g = (5*i + 1) % 16; }
            else if (i < 48) { F = B ^ C ^ D; g = (3*i + 5) % 16; }
            else { F = C ^ (B | ~D); g = (7*i) % 16; }
            F = (F + A + K[i] + M[g]) | 0;
            A = D; D = C; C = B;
            B = (B + rotl(F, S[i])) | 0;
        }
        a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
}

function urlGravatar(email, taille = 64) {
    const propre = String(email || '').trim().toLowerCase();
    return `https://www.gravatar.com/avatar/${_md5(propre)}?s=${taille}&d=404`;
}

// Palette de couleurs stable (dérivée du nom) pour l'avatar-initiales de repli.
const _PALETTE_AVATAR = ['#1a5c2a', '#ff6600', '#0088ff', '#8e44ad', '#c0392b', '#16a085', '#d35400', '#2c3e50'];
function couleurAvatar(nom) {
    let h = 0;
    for (let i = 0; i < nom.length; i++) h = nom.charCodeAt(i) + ((h << 5) - h);
    return _PALETTE_AVATAR[Math.abs(h) % _PALETTE_AVATAR.length];
}

// Construit le HTML d'un avatar : tente le Gravatar, bascule sur des
// initiales colorées via onerror si la personne n'a pas de compte Gravatar.
function htmlAvatar(nom, email, taille = 28) {
    const initiale = (nom || '?').trim().charAt(0).toUpperCase() || '?';
    const couleur = couleurAvatar(nom || email || '?');
    const src = urlGravatar(email, taille * 2);
    return `<span class="avatar-user" style="width:${taille}px;height:${taille}px;background:${couleur}">
        <span class="avatar-fallback">${initiale}</span>
        <img src="${src}" alt="" width="${taille}" height="${taille}"
             onerror="this.style.display='none'"
             onload="this.previousElementSibling.style.display='none'">
    </span>`;
}
const show = id => { const el=$(id); if(el) el.style.display=''; };
const hide = id => { const el=$(id); if(el) el.style.display='none'; };
const showFlex = id => { const el=$(id); if(el) el.style.display='flex'; };

function openOverlay(id) { const el=$(id); if(el){el.style.display='flex'; document.body.style.overflow='hidden';} }
function closeOverlay(id) {
    const el=$(id); if(el){el.style.display='none'; document.body.style.overflow='';}
    if (id === 'prod-overlay' && window.location.pathname.indexOf('/produit/') === 0) window.history.replaceState(null, '', '/');
}

// ===== DOM READY =====
// ===== FIREBASE (connexion des clients) : chargé à la demande =====
// Avant, le site attendait le téléchargement de Firebase avant de s'afficher. Maintenant il n'est chargé que pour un client déjà connecté
// (juste après l'affichage) ou au moment de se connecter, de payer ou de réinitialiser un mot de passe.
let _fbPromesse = null;
function chargerFirebase() {
    if (!_fbPromesse) {
        _fbPromesse = import('/firebase-init.js').then(() => { suivreEtatFirebase(); return true; }).catch((e) => { _fbPromesse = null; throw e; });
    }
    return _fbPromesse;
}
// Relais : les appels existants (window.fbSignInWithEmail(...), etc.) fonctionnent sans changement ; le vrai module remplace les relais une fois chargé.
['fbSignInWithPopup', 'fbSignInWithEmail', 'fbCreateUserWithEmail', 'fbSendPasswordResetEmail', 'fbConfirmPasswordReset', 'fbVerifyPasswordResetCode', 'fbSignOut'].forEach((nom) => {
    if (typeof window[nom] === 'function') return;
    const relais = async (...args) => {
        await chargerFirebase().catch(() => { throw { code: 'app/module-non-charge' }; });   // « connexion impossible, vérifie ton réseau » plutôt qu'une erreur technique
        if (window[nom] === relais) throw { code: 'app/module-non-charge' };
        if (args[0] === undefined) args[0] = window.firebaseAuth;
        if (nom === 'fbSignInWithPopup' && args[1] === undefined) args[1] = window.googleProvider;
        return window[nom](...args);
    };
    window[nom] = relais;
});
if (typeof window.fbOnAuthStateChanged !== 'function') {
    const relaisEtat = (auth, cb) => {
        let desabonner = null, annule = false;
        chargerFirebase().then(() => {
            if (annule) return;
            if (window.fbOnAuthStateChanged === relaisEtat) { cb(null); return; }   // Firebase indisponible : on traite le visiteur comme déconnecté
            desabonner = window.fbOnAuthStateChanged(window.firebaseAuth, cb);
        }).catch(() => { if (!annule) cb(null); });
        return () => { annule = true; if (desabonner) desabonner(); };
    };
    window.fbOnAuthStateChanged = relaisEtat;
}
// Garde l'affichage « connecté » synchronisé avec l'état réel de Firebase (session expirée, navigateur nettoyé, session révoquée…)
// plutôt que de laisser le client le découvrir en pleine tentative de paiement.
let _etatFirebaseSuivi = false;
function suivreEtatFirebase() {
    if (_etatFirebaseSuivi || typeof window.fbOnAuthStateChanged !== 'function' || !window.firebaseAuth) return;
    _etatFirebaseSuivi = true;
    window.fbOnAuthStateChanged(window.firebaseAuth, (fbUser) => {
        if (!fbUser && currentUser) {
            arreterEcoutePanier();
            chatWidgetEffacerMemoire(); // la discussion de l'assistant s'arrête avec la session
            currentUser = null;
            localStorage.removeItem('cmkt_user');
            $('user-zone').style.display = 'none';
            $('user-menu').style.display = 'none';
            $('btn-auth-show').style.display = '';
            notifier('🔒 Ta session a expiré, reconnecte-toi pour continuer.', 'info');
        }
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    setupPwa();

    // Session
    try {
        const saved = localStorage.getItem('cmkt_user');
        if (saved) {
            currentUser = JSON.parse(saved); showUserUI();
            // Restaure d'abord depuis le navigateur : un ajout au panier tout
            // juste avant un rafraîchissement peut ne pas avoir encore eu le
            // temps d'être envoyé au serveur (délai de 600ms) — sans ça, ce
            // dernier article ajouté disparaîtrait. chargerPanierServeur()
            // fusionne ensuite avec le serveur plutôt que d'écraser.
            restaurerPanierInvite();
            await chargerPanierServeur();
            ecouterPanierEnDirect();
        } else {
            // Pas de compte : le panier n'est jamais envoyé au serveur, donc
            // on le retrouve depuis le navigateur (localStorage) — sans ça,
            // tout redémarre à zéro à chaque fermeture d'onglet.
            restaurerPanierInvite();
        }
    } catch(e) { localStorage.removeItem('cmkt_user'); }

    // Client déjà connecté (ou lien de réinitialisation dans l'adresse) : Firebase est chargé juste après l'affichage, sans le retarder.
    if (localStorage.getItem('cmkt_user') || /[?&](mode|oobCode)=/.test(location.search)) (window.requestIdleCallback || ((f) => setTimeout(f, 800)))(() => { chargerFirebase().catch(() => {}); }, { timeout: 2500 });

    initTrackingVisiteur();
    setupChatWidget();

    // Thème
    const theme = localStorage.getItem('cmkt_theme') || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    if ($('theme-toggle')) $('theme-toggle').checked = theme === 'dark';

    if (window.emailjs && CONFIG.EMAILJS.PUBLIC_KEY) { try { emailjs.init({ publicKey: CONFIG.EMAILJS.PUBLIC_KEY }); } catch(e){ console.error('EmailJS init error:', e); } }

    // Boutons "afficher/masquer" sur tous les champs mot de passe
    document.querySelectorAll('.pwd-toggle').forEach(btn => {
        btn.onclick = () => {
            const input = $(btn.dataset.target);
            const show = input.type === 'password';
            input.type = show ? 'text' : 'password';
            btn.textContent = show ? '🙈' : '👁';
        };
    });

    await chargerParametres();
    await verifierLienResetDansURL();
    // (l'ancien traitement de retour de redirection GeniusPay a été retiré)

    // Applique la langue mémorisée (si déjà EN, met aussi à jour l'état visuel des boutons)
    appliquerTraductionUI(currentLang);
    $('btn-fr').classList.toggle('active', currentLang === 'fr');
    $('btn-en').classList.toggle('active', currentLang === 'en');

    setupSidebar();
    setupTuilesCategories();
    setupAuth();
    setupResetPassword();
    setupCategories();
    setupSearch();
    setupPanier();
    setupPaiement();
    setupModals();
    fetchProducts();
    chargerBanniere();

    // Popup à chaque chargement/rafraîchissement de page (demande explicite)
    setTimeout(afficherPopup, 2000);
});

// ===== SIDEBAR =====
// Injecte une vraie photo par catégorie (si configurée) + effet de bascule 3D douce au survol
function setupTuilesCategories() {
    document.querySelectorAll('.tuile-photo').forEach(img => {
        const url = CONFIG.CATEGORY_IMAGES && CONFIG.CATEGORY_IMAGES[img.dataset.catImg];
        if (url) { img.loading = 'lazy'; img.decoding = 'async'; img.onerror = () => { img.onerror = null; img.src = url; }; img.src = srcMini(url); img.style.display = 'block'; }
        else { img.closest('.tuile-photo-wrap').style.display = 'none'; }
    });
}

// ===== PARAMETRES (modifiables par l'admin, sans toucher au code) =====
const CAT_SLUGS = { "Téléphonie":"telephonie", "Accessoires":"accessoires", "Électronique":"electronique", "Gaming":"gaming", "Réseau":"reseau", "Flash":"flash" };

async function chargerParametres() {
    try {
        const { data } = await db.from('parametres').select('*');
        if (!data) return;
        bienvenueConfigurer(data);
        const slugToCat = Object.fromEntries(Object.entries(CAT_SLUGS).map(([k,v])=>[v,k]));
        data.forEach(({ cle, valeur }) => {
            if (!valeur) return;
            if (cle === 'agence_adresse') CONFIG.AGENCE_ADRESSE = valeur;
            else if (cle === 'agence_tel') CONFIG.AGENCE_TEL = valeur;
            else if (cle === 'miniatures_actives') { window._miniatures = (valeur === '1'); try { localStorage.setItem('cmkt_miniatures', valeur === '1' ? '1' : '0'); } catch (e) {} }
            else if (cle.startsWith('cat_img_')) {
                const slug = cle.replace('cat_img_', '');
                const cat = slugToCat[slug];
                if (cat) CONFIG.CATEGORY_IMAGES[cat] = valeur;
            }
        });
        afficherMessageBienvenue(false); // retour sur le site : message de bienvenue (si activé par l'admin)
    } catch (e) { console.error('Erreur chargement paramètres:', e); }
}

// ===== MESSAGE DE BIENVENUE =====
// Texte rédigé par l'administrateur (onglet Paramètres), affiché dans une fenêtre avec un bouton « OK » :
//   - à chaque retour sur le site (après 30 minutes d'absence) ;
//   - à chaque connexion et à chaque création de compte (même s'il vient de s'afficher).
// Le texte est affiché tel quel (jamais interprété comme du code) ; jamais dans l'espace administrateur.
const BIENVENUE_ECART_MS = 30 * 60 * 1000;
const BIENVENUE_MAX = 600;
let bienvenueConfig = { actif: false, message: '' };
const bvLire = (cle) => { try { return Number(localStorage.getItem(cle)) || 0; } catch (e) { return 0; } };
const bvEcrire = (cle, valeur) => { try { localStorage.setItem(cle, String(valeur)); } catch (e) { /* navigation privée : on ignore */ } };

function bienvenueConfigurer(lignes) {
    const m = {};
    (lignes || []).forEach(l => { if (l && l.cle) m[l.cle] = l.valeur; });
    bienvenueConfig = { actif: m.bienvenue_actif === '1', message: String(m.bienvenue_message || '').trim().slice(0, BIENVENUE_MAX) };
}
function bienvenueFermer() {
    const o = document.getElementById('bienvenue-overlay');
    if (o) o.remove();
    if (document.body.classList) document.body.classList.remove('bv-ouvert');
}
function bienvenueAfficher(texte) {
    const ancien = document.getElementById('bienvenue-overlay');
    if (ancien) ancien.remove();
    const o = document.createElement('div');
    o.id = 'bienvenue-overlay';
    o.className = 'bv-overlay';
    o.tabIndex = -1;
    o.setAttribute('role', 'dialog');
    o.setAttribute('aria-modal', 'true');
    o.setAttribute('aria-label', 'Message de bienvenue');
    o.onkeydown = e => { if (e.key === 'Escape') bienvenueFermer(); };
    const carte = document.createElement('div');
    carte.className = 'bv-carte';
    const logo = document.createElement('img');
    logo.className = 'bv-logo';
    logo.src = '/logo.png';
    logo.alt = 'Kapmaket';
    logo.onerror = () => logo.remove();
    const corps = document.createElement('div');
    corps.className = 'bv-texte';
    corps.textContent = texte; // textContent : le texte de l'admin ne peut jamais exécuter de code
    const ok = document.createElement('button');
    ok.className = 'bv-ok';
    ok.textContent = 'OK';
    ok.onclick = bienvenueFermer;
    carte.appendChild(logo);
    carte.appendChild(corps);
    carte.appendChild(ok);
    o.appendChild(carte);
    document.body.appendChild(o);
    if (document.body.classList) document.body.classList.add('bv-ouvert');
    if (ok.focus) ok.focus();
}
function afficherMessageBienvenue(forcer) {
    if (!bienvenueConfig.actif || !bienvenueConfig.message) return false;
    if (document.getElementById('bienvenue-overlay')) return false;
    const dernier = bvLire('kap_bienvenue_dernier');
    if (!forcer && dernier && Date.now() - dernier < BIENVENUE_ECART_MS) return false;
    bvEcrire('kap_bienvenue_dernier', Date.now());
    bienvenueAfficher(bienvenueConfig.message);
    return true;
}
// ===== FIN MESSAGE DE BIENVENUE =====

// ===== TRADUCTION (FR/EN) =====
const I18N = {
    fr: {
        nav_accueil: '🏠 Accueil', nav_flash: '⚡ Ventes Flash', nav_combo: '🎁 Flash Combo', nav_promo: '🏷️ Promotions',
        nav_nouveautes: '🆕 Nouveautés', nav_meilleures: '⭐ Meilleures ventes',
        sep_categories: 'Catégories', sep_services: 'Services', sep_preferences: 'Préférences',
        cat_telephonie_ic: '📱 Téléphonie', cat_accessoires_ic: '🎧 Accessoires', cat_electronique_ic: '💻 Électronique',
        cat_reseau_ic: '📡 Réseau', cat_gaming_ic: '🎮 Gaming', cat_autre_ic: '📦 Autre',
        cat_telephonie: 'Téléphonie', cat_accessoires: 'Accessoires', cat_electronique: 'Électronique',
        cat_reseau: 'Réseau', cat_gaming: 'Gaming', cat_flash: 'Flash', cat_tous: 'Tous', cat_autre: 'Autre',
        nav_suivi: '🚚 Suivi de commande', nav_loc: '🏪 Localisation boutique', nav_contact: '📞 Nous contacter', nav_retour: '🔄 Politique de retour', nav_politique: '🔒 Politique de confidentialité',
        pref_langue: '🌍 Langue', pref_sombre: '🌙 Mode sombre', pref_zone: '📍 Ma zone', pref_prixmax: '💰 Prix max (FCFA)',
        choisir: 'Choisir...', retrait_gratuit: '🏪 Retrait gratuit',
        rechercher_ph: '🔎 Rechercher un produit...', btn_connexion: '👤 Connexion',
        titre_flash: '⚡ Ventes Flash', titre_produits: '🛒 Nos Produits', chargement: 'Chargement...',
        footer_sub: 'Votre boutique tech à Douala', footer_copy: '© {annee} Kapmaket — Douala, Cameroun',
        tab_connexion: 'Connexion', tab_inscription: 'Inscription', titre_connexion: '👤 Connexion',
        ph_email: 'Adresse email', ph_mdp: 'Mot de passe', btn_se_connecter: 'Se connecter',
        btn_mdp_oublie: 'Mot de passe oublié ?', ou: 'ou', btn_google: 'Continuer avec Google', effacer_recherche: '✕ Effacer la recherche',
        titre_creer_compte: '📝 Créer un compte', ph_nom: 'Nom complet *', ph_email_req: 'Email *',
        ph_tel_livraison: 'Téléphone (9 chiffres) — pour la livraison *', ph_mdp_req: 'Mot de passe *',
        ph_confirmer_mdp: 'Confirmer mot de passe *', btn_creer_compte: 'Créer mon compte',
        titre_tel_manquant: '📞 Un dernier détail', txt_tel_manquant: 'Ton numéro de téléphone nous sert uniquement pour organiser la livraison de tes commandes.',
        ph_tel: 'Téléphone (9 chiffres)', btn_continuer: 'Continuer',
        titre_mdp_oublie: '🔑 Mot de passe oublié', txt_mdp_oublie: 'Entre ton email, on t\'envoie un lien pour choisir un nouveau mot de passe.',
        titre_panier: '🛒 Mon Panier', label_zone: '📍 Zone de livraison', choisir_zone: '-- Choisir votre zone --',
        ph_note: 'Note pour la commande (optionnel)...', btn_payer: '💳 Payer maintenant (Mobile Money)',
        btn_reserver: '📋 Réserver (paiement à la livraison)',
        txt_accepte_politique: 'J\'ai lu et j\'accepte la', lien_politique: 'politique de confidentialité', txt_et_les: 'et les', lien_cgu: 'conditions d\'utilisation', nav_cgu: '📜 Conditions d\'utilisation',
        err_politique_requise: '❌ Tu dois accepter la politique de confidentialité pour continuer'
    },
    en: {
        nav_accueil: '🏠 Home', nav_flash: '⚡ Flash Sales', nav_combo: '🎁 Flash Combo', nav_promo: '🏷️ Promotions',
        nav_nouveautes: '🆕 New Arrivals', nav_meilleures: '⭐ Best Sellers',
        sep_categories: 'Categories', sep_services: 'Services', sep_preferences: 'Preferences',
        cat_telephonie_ic: '📱 Phones', cat_accessoires_ic: '🎧 Accessories', cat_electronique_ic: '💻 Electronics',
        cat_reseau_ic: '📡 Network', cat_gaming_ic: '🎮 Gaming', cat_autre_ic: '📦 Other',
        cat_telephonie: 'Phones', cat_accessoires: 'Accessories', cat_electronique: 'Electronics',
        cat_reseau: 'Network', cat_gaming: 'Gaming', cat_flash: 'Flash', cat_tous: 'All', cat_autre: 'Other',
        nav_suivi: '🚚 Track Order', nav_loc: '🏪 Store Location', nav_contact: '📞 Contact Us', nav_retour: '🔄 Return Policy', nav_politique: '🔒 Privacy Policy',
        pref_langue: '🌍 Language', pref_sombre: '🌙 Dark Mode', pref_zone: '📍 My Area', pref_prixmax: '💰 Max Price (FCFA)',
        choisir: 'Choose...', retrait_gratuit: '🏪 Free pickup',
        rechercher_ph: '🔎 Search a product...', btn_connexion: '👤 Login',
        titre_flash: '⚡ Flash Sales', titre_produits: '🛒 Our Products', chargement: 'Loading...',
        footer_sub: 'Your tech shop in Douala', footer_copy: '© {annee} Kapmaket — Douala, Cameroon',
        tab_connexion: 'Login', tab_inscription: 'Sign up', titre_connexion: '👤 Login',
        ph_email: 'Email address', ph_mdp: 'Password', btn_se_connecter: 'Log in',
        btn_mdp_oublie: 'Forgot password?', ou: 'or', btn_google: 'Continue with Google', effacer_recherche: '✕ Clear search',
        titre_creer_compte: '📝 Create an account', ph_nom: 'Full name *', ph_email_req: 'Email *',
        ph_tel_livraison: 'Phone (9 digits) — for delivery *', ph_mdp_req: 'Password *',
        ph_confirmer_mdp: 'Confirm password *', btn_creer_compte: 'Create my account',
        titre_tel_manquant: '📞 One last detail', txt_tel_manquant: 'Your phone number is only used to organize delivery of your orders.',
        ph_tel: 'Phone (9 digits)', btn_continuer: 'Continue',
        titre_mdp_oublie: '🔑 Forgot password', txt_mdp_oublie: 'Enter your email, we\'ll send you a link to choose a new password.',
        titre_panier: '🛒 My Cart', label_zone: '📍 Delivery area', choisir_zone: '-- Choose your area --',
        ph_note: 'Note for the order (optional)...', btn_payer: '💳 Pay now (Mobile Money)',
        btn_reserver: '📋 Reserve (pay on pickup/delivery)',
        txt_accepte_politique: 'I have read and accept the', lien_politique: 'privacy policy', txt_et_les: 'and the', lien_cgu: 'terms of use', nav_cgu: '📜 Terms of use',
        err_politique_requise: '❌ You must accept the privacy policy to continue'
    }
};

let currentLang = localStorage.getItem('cmkt_lang') || 'fr';
let translatedProductsCache = {}; // { productId: { name, description } } — en anglais uniquement

function appliquerTraductionUI(lang) {
    const dict = I18N[lang];
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        if (dict[key] !== undefined) el.textContent = dict[key].replace('{annee}', new Date().getFullYear());
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => {
        const key = el.dataset.i18nPh;
        if (dict[key] !== undefined) el.placeholder = dict[key];
    });
    document.documentElement.lang = lang;
}

async function setLang(lang) {
    if (lang === currentLang) return;
    currentLang = lang;
    localStorage.setItem('cmkt_lang', lang);
    $('btn-fr').classList.toggle('active', lang === 'fr');
    $('btn-en').classList.toggle('active', lang === 'en');
    appliquerTraductionUI(lang);

    if (lang === 'en') {
        await traduireProduitsSiNecessaire(allProducts);
    }
    renderProducts(allProducts.length ? (currentCat === 'tous' ? allProducts : allProducts.filter(p => p.category === currentCat)) : allProducts);
    chargerFlash(allProducts);
    if (modalProduct) openModal(modalProduct.id);
}

// Traduit en anglais (une seule fois, mis en cache) les produits pas encore traduits
async function traduireProduitsSiNecessaire(produits) {
    const aTraduire = produits.filter(p => !translatedProductsCache[p.id]);
    if (!aTraduire.length) return;
    try {
        const resp = await fetch('/api/traduire-produits', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ produits: aTraduire.map(p => ({ id: p.id, name: p.name, description: p.description || '' })) })
        });
        const data = await resp.json();
        if (Array.isArray(data)) {
            data.forEach(t => { translatedProductsCache[t.id] = { name: t.name, description: t.description }; });
        }
    } catch (e) { console.error('Erreur traduction produits:', e); }
}

// Retourne le nom/description à afficher selon la langue active (fallback français si pas encore traduit)
function texteProduit(p) {
    if (currentLang === 'en' && translatedProductsCache[p.id]) {
        return { name: translatedProductsCache[p.id].name || p.name, description: translatedProductsCache[p.id].description || p.description };
    }
    return { name: p.name, description: p.description };
}

// Retourne le nom de catégorie affiché dans la langue active (les valeurs stockées restent en français)
const CAT_KEY = { 'Téléphonie':'cat_telephonie', 'Accessoires':'cat_accessoires', 'Électronique':'cat_electronique', 'Réseau':'cat_reseau', 'Gaming':'cat_gaming', 'Autre':'cat_autre' };
function catLabel(cat) {
    const key = CAT_KEY[cat];
    return key ? I18N[currentLang][key] : cat;
}

function setupSidebar() {
    $('hamburger').onclick = () => { $('sidebar').classList.add('open'); $('sidebar-overlay').classList.add('active'); };
    $('sidebar-close').onclick = closeSidebar;
    $('sidebar-overlay').onclick = closeSidebar;

    function closeSidebar() { $('sidebar').classList.remove('open'); $('sidebar-overlay').classList.remove('active'); }

    $('sl-accueil').onclick = () => { closeSidebar(); if (document.body.classList.contains('mode-recherche')) { finRecherche(true); renderProducts(allProducts); } window.scrollTo({top:0,behavior:'smooth'}); };
    $('sl-flash').onclick = () => { closeSidebar(); filtrerFlash(); };
    $('sl-combo').onclick = () => {
        closeSidebar();
        if (flashComboActif) { ouvrirCompositionFlashCombo(); }
        else { notifier("Aucun Flash Combo actif pour le moment — reviens bientôt !", 'info'); }
    };
    $('sl-politique').onclick = () => { closeSidebar(); openOverlay('politique-overlay'); };
    $('sl-cgu').onclick = () => { closeSidebar(); openOverlay('cgu-overlay'); };
    $('sl-promo').onclick = () => { closeSidebar(); finRecherche(true); renderProducts(allProducts.filter(p=>p.promo_active)); };
    $('sl-nouveautes').onclick = () => { closeSidebar(); finRecherche(true); renderProducts(allProducts.filter(p=>isNew(p.created_at))); };
    $('sl-meilleures').onclick = () => { closeSidebar(); afficherMeilleuresVentes(); };
    $('sl-tel').onclick = () => { closeSidebar(); filtrerCat('Téléphonie'); };
    $('sl-acc').onclick = () => { closeSidebar(); filtrerCat('Accessoires'); };
    $('sl-elec').onclick = () => { closeSidebar(); filtrerCat('Électronique'); };
    $('sl-res').onclick = () => { closeSidebar(); filtrerCat('Réseau'); };
    $('sl-gam').onclick = () => { closeSidebar(); filtrerCat('Gaming'); };
    $('sl-suivi').onclick = () => { closeSidebar(); openOverlay('suivi-overlay'); };
    $('sl-loc').onclick = () => { closeSidebar(); openOverlay('loc-overlay'); };
    $('sl-retour').onclick = () => { closeSidebar(); openOverlay('retour-overlay'); };
    $('sl-telecharger-app').onclick = () => { closeSidebar(); ouvrirPresentationTelechargement(); };

    $('theme-toggle').onchange = () => {
        const t = $('theme-toggle').checked ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', t);
        localStorage.setItem('cmkt_theme', t);
    };

    $('btn-fr').onclick = () => setLang('fr');
    $('btn-en').onclick = () => setLang('en');

    $('sidebar-zone').onchange = () => { userZone = $('sidebar-zone').value; $('zone-select').value = userZone; updateLivraison(); };
    $('prix-max-filter').onchange = () => {
        const max = parseFloat($('prix-max-filter').value);
        finRecherche(true);
        renderProducts(max ? allProducts.filter(p=>getPrix(p)<=max) : allProducts);
    };
}

// ===== AUTH =====
let pendingFbUser = null;

// Crée ou charge le profil Supabase (nom/téléphone/email) lié à un compte Firebase.
// Retourne true si le profil est prêt et currentUser est défini.
async function creerOuChargerProfil(fbUser, extra = {}) {
    // Lecture du profil via la route serveur (jeton Firebase vérifié côté
    // serveur) plutôt qu'en interrogeant Supabase directement depuis le
    // navigateur — la table utilisateurs n'est plus lisible publiquement.
    let profil = null;
    try {
        const idToken = await fbUser.getIdToken();
        const resp = await fetch('/api/mon-profil', { headers: { 'Authorization': 'Bearer ' + idToken } });
        if (resp.ok) { const j = await resp.json(); profil = j.profil; }
    } catch (e) { console.error('Erreur chargement profil:', e); }
    if (profil) {
        currentUser = profil;
        localStorage.setItem('cmkt_user', JSON.stringify(profil));
        showUserUI();
        lierSessionVisiteur();
        await chargerPanierServeur(true);
        ecouterPanierEnDirect();
        return { ok: true };
    }
    if (extra.telephone) {
        // Passe par le serveur (jeton Firebase vérifié) car la clé publique
        // n'a plus le droit d'écrire dans utilisateurs (RLS durci).
        try {
            const idToken = await fbUser.getIdToken();
            const resp = await fetch('/api/creer-profil', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
                body: JSON.stringify({
                    nom: extra.nom || fbUser.displayName || 'Client',
                    telephone: extra.telephone,
                    email: fbUser.email,
                    politiqueAcceptee: !!extra.politiqueAcceptee
                })
            });
            const j = await resp.json();
            if (!resp.ok) { console.error('Erreur création profil:', j.error); return { ok: false, error: j.error }; }
            currentUser = j.profil;
            localStorage.setItem('cmkt_user', JSON.stringify(j.profil));
            showUserUI();
            lierSessionVisiteur();
            await chargerPanierServeur(true);
            ecouterPanierEnDirect();
            return { ok: true };
        } catch (e) {
            console.error('Erreur création profil:', e);
            return { ok: false, error: e.message };
        }
    }
    // Première connexion (Google) sans téléphone connu : on le demande.
    pendingFbUser = fbUser;
    $('tel-manquant-input').value = '';
    $('tel-manquant-err').textContent = '';
    $('tel-manquant-politique').checked = false;
    openOverlay('tel-manquant-overlay');
    return { ok: false, pending: true };
}

// Filet de sécurité : si le stockage interne de Firebase est brièvement fermé par le navigateur
// (« Database is closing/hidden », fréquent sur mobile), on réessaie UNE fois après un court délai.
// Réservé aux opérations sans effet de bord (la connexion), jamais à la création de compte.
async function avecReessaiBase(operation) {
    try {
        return await operation();
    } catch (e) {
        if (e && /Database is closing\/hidden/i.test(String((e && e.message) || e))) {
            await new Promise(r => setTimeout(r, 700));
            return await operation();
        }
        throw e;
    }
}

function traduireErreurFirebase(erreur) {
    // Accepte l'objet erreur (recommandé) ou directement un code.
    const code = typeof erreur === 'string' ? erreur : (erreur && erreur.code);
    const map = {
        'auth/invalid-email': 'Adresse email invalide',
        'auth/user-not-found': 'Aucun compte avec cet email',
        'auth/wrong-password': 'Mot de passe incorrect',
        'auth/invalid-credential': 'Email ou mot de passe incorrect',
        'auth/email-already-in-use': 'Un compte existe déjà avec cet email',
        'auth/weak-password': 'Mot de passe trop court (6 min)',
        'auth/too-many-requests': 'Trop de tentatives, réessaie plus tard',
        'auth/popup-closed-by-user': 'Fenêtre Google fermée avant la fin',
        'auth/network-request-failed': 'Connexion internet instable, réessaie',
        'auth/popup-blocked': 'Fenêtre Google bloquée par le navigateur : autorise les popups',
        'auth/unauthorized-domain': "Cette adresse du site n'est pas autorisée pour la connexion Google",
        'auth/operation-not-supported-in-this-environment': 'Ce navigateur ne permet pas cette connexion, essaie avec un autre',
        'app/module-non-charge': "Le service de connexion ne s'est pas chargé : vérifie ta connexion internet puis recharge la page"
    };
    if (map[code]) return map[code];
    if (code && code.indexOf('auth/requests-from-referer') === 0) return 'Cette adresse du site est bloquée pour la connexion (clé API) [' + code + ']';
    // Erreur inconnue : on affiche un court code technique pour pouvoir la diagnostiquer.
    const detail = code || (erreur && erreur.name) || 'erreur';
    const msg = (!code && erreur && erreur.message) ? ' : ' + String(erreur.message).slice(0, 80) : '';
    return 'Une erreur est survenue, réessaie (' + detail + msg + ')';
}

function setupAuth() {
    $('btn-auth-show').onclick = () => openOverlay('auth-overlay');
    $('auth-close').onclick = () => closeOverlay('auth-overlay');
    $('auth-overlay').onclick = e => { if(e.target===$('auth-overlay')) closeOverlay('auth-overlay'); };

    $('lien-politique-reg').onclick = e => { e.preventDefault(); openOverlay('politique-overlay'); };
    $('lien-politique-tel').onclick = e => { e.preventDefault(); openOverlay('politique-overlay'); };
    $('lien-cgu-reg').onclick = e => { e.preventDefault(); openOverlay('cgu-overlay'); };
    $('lien-cgu-tel').onclick = e => { e.preventDefault(); openOverlay('cgu-overlay'); };

    $('atab-login').onclick = () => {
        $('atab-login').classList.add('active'); $('atab-reg').classList.remove('active');
        show('form-login'); hide('form-reg');
    };
    $('atab-reg').onclick = () => {
        $('atab-reg').classList.add('active'); $('atab-login').classList.remove('active');
        hide('form-login'); show('form-reg');
        $('reg-politique').checked = false;
    };

    $('btn-login').onclick = async () => {
        const email = $('login-email').value.trim();
        const mdp = $('login-mdp').value.trim();
        const err = $('login-err');
        err.textContent = '';
        if (!email.includes('@')) { err.textContent = '❌ Email invalide'; return; }
        if (!mdp) { err.textContent = '❌ Mot de passe requis'; return; }
        $('btn-login').textContent = 'Connexion...';
        let cred = null;
        try {
            // Le module Firebase est chargé depuis Internet : s'il n'a pas pu l'être
            // (réseau mobile instable), on le dit clairement au lieu d'une erreur vague.
            if (typeof window.fbSignInWithEmail !== 'function') throw { code: 'app/module-non-charge' };
            cred = await avecReessaiBase(() => window.fbSignInWithEmail(window.firebaseAuth, email, mdp));
        } catch (e) {
            console.error('Connexion e-mail :', e);
            err.textContent = '❌ ' + traduireErreurFirebase(e);
        }
        if (cred) {
            try {
                const r = await creerOuChargerProfil(cred.user);
                if (r.ok) { closeOverlay('auth-overlay'); renderProducts(allProducts); afficherMessageBienvenue(true); }
                else if (!r.pending) { err.textContent = '❌ Profil introuvable : ' + (r.error?.message || r.error || 'contacte le support'); }
            } catch (e) {
                // Connexion réussie mais un problème est survenu juste après : un rechargement
                // de la page reconnecte automatiquement le client.
                console.error('Chargement du profil après connexion :', e);
                err.textContent = '❌ Connecté, mais le chargement du profil a échoué (' + String((e && e.message) || e).slice(0, 80) + '). Recharge la page.';
            }
        }
        $('btn-login').textContent = 'Se connecter';
    };

    $('btn-google-login').onclick = async () => {
        const err = $('login-err');
        err.textContent = '';
        try {
            const cred = await window.fbSignInWithPopup(window.firebaseAuth, window.googleProvider);
            const r = await creerOuChargerProfil(cred.user);
            if (r.ok) { closeOverlay('auth-overlay'); renderProducts(allProducts); afficherMessageBienvenue(true); }
            else if (!r.pending) { err.textContent = '❌ ' + (r.error?.message || r.error || 'Erreur, réessaie'); }
        } catch (e) {
            err.textContent = '❌ ' + traduireErreurFirebase(e);
        }
    };

    // Même bouton Google, dupliqué visuellement dans l'onglet Inscription pour plus de clarté
    // (le compte est de toute façon créé/chargé via creerOuChargerProfil, identique aux deux endroits).
    $('btn-google-login-reg').onclick = async () => {
        const err = $('reg-err');
        err.textContent = '';
        try {
            const cred = await window.fbSignInWithPopup(window.firebaseAuth, window.googleProvider);
            const r = await creerOuChargerProfil(cred.user);
            if (r.ok) { closeOverlay('auth-overlay'); renderProducts(allProducts); afficherMessageBienvenue(true); }
            else if (!r.pending) { err.textContent = '❌ ' + (r.error?.message || r.error || 'Erreur, réessaie'); }
        } catch (e) {
            err.textContent = '❌ ' + traduireErreurFirebase(e);
        }
    };

    $('btn-tel-manquant-confirmer').onclick = async () => {
        const tel = $('tel-manquant-input').value.trim();
        const err = $('tel-manquant-err');
        if (tel.length !== 9) { err.textContent = '❌ Numéro invalide (9 chiffres)'; return; }
        if (!$('tel-manquant-politique').checked) { err.textContent = I18N[currentLang].err_politique_requise; return; }
        const r = await creerOuChargerProfil(pendingFbUser, { telephone: tel, politiqueAcceptee: true });
        if (r.ok) { closeOverlay('tel-manquant-overlay'); closeOverlay('auth-overlay'); renderProducts(allProducts); afficherMessageBienvenue(true); }
        else { err.textContent = '❌ ' + (r.error?.message || r.error || 'Erreur, réessaie'); }
    };

    $('btn-register').onclick = async () => {
        const nom = $('reg-nom').value.trim();
        const email = $('reg-email').value.trim();
        const tel = $('reg-tel').value.trim();
        const mdp = $('reg-mdp').value.trim();
        const mdp2 = $('reg-mdp2').value.trim();
        const err = $('reg-err');
        err.textContent = '';
        if (!nom) { err.textContent = '❌ Nom obligatoire'; return; }
        if (!email.includes('@')) { err.textContent = '❌ Email invalide'; return; }
        if (tel.length !== 9) { err.textContent = '❌ Numéro invalide (9 chiffres)'; return; }
        if (mdp.length < 6) { err.textContent = '❌ Mot de passe trop court (6 min)'; return; }
        if (mdp !== mdp2) { err.textContent = '❌ Mots de passe différents'; return; }
        if (!$('reg-politique').checked) { err.textContent = I18N[currentLang].err_politique_requise; return; }
        $('btn-register').textContent = 'Création...';
        try {
            const cred = await window.fbCreateUserWithEmail(window.firebaseAuth, email, mdp);
            const r = await creerOuChargerProfil(cred.user, { nom, telephone: tel, politiqueAcceptee: true });
            $('btn-register').textContent = 'Créer mon compte';
            if (r.ok) { closeOverlay('auth-overlay'); afficherMessageBienvenue(true); }
            else { err.textContent = '❌ Compte créé mais profil non enregistré : ' + (r.error?.message || 'contacte le support'); }
        } catch (e) {
            $('btn-register').textContent = 'Créer mon compte';
            err.textContent = '❌ ' + traduireErreurFirebase(e);
        }
    };

    $('btn-logout').onclick = () => {
        window.fbSignOut(window.firebaseAuth).catch(()=>{});
        arreterEcoutePanier();
        chatWidgetEffacerMemoire(); // la discussion de l'assistant s'arrête avec la session
        currentUser = null;
        localStorage.removeItem('cmkt_user');
        $('user-zone').style.display = 'none';
        $('user-menu').style.display = 'none';
        $('btn-auth-show').style.display = '';
        panier = []; updatePanierBtn();
        try { localStorage.removeItem('cmkt_panier_invite'); } catch (e) {} // pas de panier de compte laissé sur un appareil partagé
        renderProducts(allProducts);
    };

    // Le bouton déconnexion est caché dans un petit menu (clic sur le nom)
    // plutôt que visible en permanence dans le header.
    $('user-nom').onclick = (e) => {
        e.stopPropagation();
        const menu = $('user-menu');
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    };
    document.addEventListener('click', (e) => {
        const menu = $('user-menu');
        if (menu && menu.style.display !== 'none' && !menu.contains(e.target) && e.target !== $('user-nom')) {
            menu.style.display = 'none';
        }
    });

    $('btn-commandes').onclick = chargerCommandes;
    $('btn-fidelite-favoris').onclick = afficherPanneauFideliteFavoris;
}

function showUserUI() {
    $('user-nom').innerHTML = htmlAvatar(currentUser.nom, currentUser.email);
    $('user-menu-nom').textContent = currentUser.nom;
    $('user-zone').style.display = 'flex';
    $('btn-auth-show').style.display = 'none';
    chargerFavoris();
    abonnerPushSiConnecte();
    if ('setAppBadge' in navigator) {
        (async () => {
            try {
                const fbUser = await attendreFirebaseUser();
                if (!fbUser) return;
                const idToken = await fbUser.getIdToken();
                const resp = await fetch(CONFIG.API.PREPARER_PAIEMENT, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
                    body: JSON.stringify({ mescommandes: true })
                });
                const result = await resp.json();
                const count = result.success ? (result.commandes || []).filter(r => ['reservee','paiement_en_cours'].includes(r.statut)).length : 0;
                if (count > 0) navigator.setAppBadge(count); else navigator.clearAppBadge();
            } catch (e) {}
        })();
    }
}

// ===== FIDELITE =====
function palierFidelite(points) {
    if (points >= 2000) return { nom: 'Or', icone: '🥇' };
    if (points >= 500) return { nom: 'Argent', icone: '🥈' };
    return { nom: 'Bronze', icone: '🥉' };
}

// Panneau combiné favoris + points fidélité (une seule icône dans le
// header, au lieu de deux éléments séparés).
function afficherPanneauFideliteFavoris() {
    const pts = currentUser.points || 0;
    const palier = palierFidelite(pts);
    const prochain = pts < 500 ? 500 : pts < 2000 ? 2000 : null;
    const el = document.createElement('div');
    el.className = 'modal-overlay';
    el.style.display = 'flex';
    el.innerHTML = `<div class="modal" style="max-width:380px;text-align:center;padding:26px 22px">
        <button class="modal-x" onclick="this.closest('.modal-overlay').remove()">✕</button>
        <div style="font-size:2.2rem;margin-bottom:6px">${palier.icone}</div>
        <div style="font-family:var(--font-title);font-weight:700;font-size:1.3rem;color:var(--green)">${pts} pts</div>
        <div style="color:var(--text2);font-size:0.85rem;margin-top:4px">Palier ${palier.nom}${prochain ? ` — encore ${prochain-pts} pts avant le palier suivant` : ' — palier maximum atteint 🎉'}</div>
        <p style="color:var(--text3);font-size:0.75rem;margin-top:10px">1 point gagné tous les 1 000 FCFA dépensés, dès qu'une commande est validée.</p>
        ${pts >= 100 ? `
        <div style="background:var(--bg);border-radius:12px;padding:14px;margin-top:16px;text-align:left">
            <div style="font-weight:700;font-size:0.85rem;margin-bottom:8px">🎟️ Convertir en bon de réduction</div>
            <div style="font-size:0.75rem;color:var(--text3);margin-bottom:10px">100 points = 500 FCFA de réduction, valable 90 jours sur ta prochaine commande.</div>
            <div style="display:flex;gap:8px;align-items:center">
                <input type="number" id="fid-points-input" value="100" min="100" max="${Math.floor(pts/100)*100}" step="100" oninput="document.getElementById('fid-montant-preview').textContent = fmt((this.value/100)*500)" style="width:90px;background:var(--card);border:1.5px solid var(--border);padding:8px 10px;border-radius:8px;font-size:0.85rem;color:var(--text)">
                <span style="font-size:0.8rem;color:var(--text2)">pts = <strong id="fid-montant-preview">${fmt(500)}</strong> FCFA</span>
            </div>
            <button onclick="convertirPointsFidelite()" style="width:100%;margin-top:10px;background:var(--green);color:#fff;border:none;padding:10px;border-radius:var(--radius-pill);font-weight:600;cursor:pointer;font-size:0.82rem">Convertir</button>
        </div>` : `<p style="font-size:0.75rem;color:var(--text3);margin-top:14px">Encore ${100-pts} points avant de pouvoir créer ton premier bon de réduction.</p>`}
        <button onclick="this.closest('.modal-overlay').remove();afficherFavoris()" style="width:100%;margin-top:14px;background:var(--card);border:1.5px solid var(--border);color:var(--text);padding:12px;border-radius:var(--radius-pill);font-weight:600;cursor:pointer;font-family:var(--font-body)">🤍 Voir mes favoris</button>
    </div>`;
    document.body.appendChild(el);
}

window.convertirPointsFidelite = async () => {
    const input = $('fid-points-input');
    const points = parseInt(input.value, 10);
    if (!points || points < 100 || points % 100 !== 0) { notifier('❌ Entre un multiple de 100 points.', 'erreur'); return; }
    try {
        const fbUser = await attendreFirebaseUser();
        if (!fbUser) { notifier('❌ Session expirée, reconnecte-toi.', 'erreur'); return; }
        const idToken = await fbUser.getIdToken();
        const resp = await fetch('/api/mon-profil', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
            body: JSON.stringify({ action: 'convertir_points', points })
        });
        const data = await resp.json();
        if (!resp.ok) { notifier('❌ ' + (data.error || 'Erreur lors de la conversion.'), 'erreur'); return; }
        currentUser.points = data.points_restants;
        document.querySelector('.modal-overlay')?.remove();
        notifier(`🎉 Bon créé : ${data.code} (-${fmt(data.montant)} FCFA), valable 90 jours. Code copié !`, 'succes');
        navigator.clipboard?.writeText(data.code).catch(()=>{});
    } catch (e) {
        notifier('❌ Erreur réseau lors de la conversion.', 'erreur');
    }
};

// ===== FLASH COMBO (kit sur-mesure à prix forfaitaire) =====
let flashComboActif = null; // { id, nom, prix_ensemble, nb_choix_requis, produit_principal, choix:[...], date_fin }
let flashComboMinuteur = null;
let flashCombosValides = []; // toutes les offres actives en même temps, pour l'alternance
let flashComboIndex = 0;
let flashComboRotation = null;

async function chargerFlashCombo() {
    try {
        const maintenant = new Date().toISOString();
        const { data: offres } = await db.from('offres_groupees')
            .select('*, produit_principal:produit_principal_id(*)')
            .eq('actif', true);
        if (!offres || !offres.length) { $('flash-combo-bar').style.display = 'none'; return; }

        // Ne garde que les offres réellement dans leur fenêtre de dates (si définie).
        const valides = offres.filter(o =>
            (!o.date_debut || o.date_debut <= maintenant) && (!o.date_fin || o.date_fin >= maintenant)
        );
        if (!valides.length) { $('flash-combo-bar').style.display = 'none'; return; }

        // La plus urgente (celle qui se termine le plus tôt) passe en
        // premier ; s'il y en a plusieurs, elles alternent ensuite dans le
        // même bandeau au lieu de n'en montrer qu'une seule en permanence.
        valides.sort((a, b) => (a.date_fin || '9999') > (b.date_fin || '9999') ? 1 : -1);

        for (const offre of valides) {
            const { data: choixRows } = await db.from('offres_groupees_choix')
                .select('produit_id, products(*)').eq('offre_id', offre.id);
            offre.choix = (choixRows || []).map(c => c.products).filter(Boolean);
            offre.prix_ensemble_reel = Math.round(offre.prix_ensemble || 0); // prix réellement encaissé
            offre.prix_ensemble = prixCharme(offre.prix_ensemble);               // prix affiché
        }

        flashCombosValides = valides;
        flashComboIndex = 0;
        flashComboActif = flashCombosValides[0];
        afficherBandeauFlashCombo();
        demarrerRotationFlashCombo();
    } catch (e) { console.error('Erreur chargement Flash Combo:', e); }
}

// Alterne entre les Flash Combo actifs en même temps, toutes les 6 secondes
// — un seul emplacement dans le header, mais chacun a son tour d'affichage
// au lieu qu'un seul écrase silencieusement les autres.
function demarrerRotationFlashCombo() {
    clearInterval(flashComboRotation);
    if (flashCombosValides.length < 2) return;
    flashComboRotation = setInterval(() => {
        flashComboIndex = (flashComboIndex + 1) % flashCombosValides.length;
        flashComboActif = flashCombosValides[flashComboIndex];
        const bar = $('flash-combo-bar');
        bar.style.transition = 'opacity 0.25s ease';
        bar.style.opacity = '0';
        setTimeout(() => { afficherBandeauFlashCombo(); bar.style.opacity = '1'; }, 250);
    }, 6000);
}

function afficherBandeauFlashCombo() {
    const o = flashComboActif;
    if (!o) return;
    const bar = $('flash-combo-bar');
    $('flash-combo-texte').textContent = `FLASH COMBO — ${o.nom} : compose ton kit à ${fmt(o.prix_ensemble)} FCFA !`;
    bar.style.display = 'flex';
    bar.onclick = ouvrirCompositionFlashCombo;

    // Petites vignettes produits (principal + quelques accessoires) qui
    // flottent en 3D de façon asynchrone — donne vie au bandeau sans texte
    // supplémentaire à lire.
    const visuels = [o.produit_principal, ...(o.choix||[])].filter(p => p && p.image_url).slice(0, 4);
    $('flash-combo-mini-produits').innerHTML = visuels.map((p, i) =>
        `<img src="${p.image_url}" alt="" style="animation-delay:${(i * 0.35).toFixed(2)}s;z-index:${visuels.length - i}">`
    ).join('');

    clearInterval(flashComboMinuteur);
    const timerEl = $('flash-combo-timer');
    if (!o.date_fin) { timerEl.style.display = 'none'; return; }
    timerEl.style.display = 'inline-block';
    const maj = () => {
        const restant = new Date(o.date_fin) - new Date();
        if (restant <= 0) {
            clearInterval(flashComboMinuteur);
            // Cette offre précise vient d'expirer en plein affichage —
            // on la retire de la rotation plutôt que de cacher tout le
            // bandeau s'il en reste d'autres encore valides.
            flashCombosValides = flashCombosValides.filter(x => x.id !== o.id);
            if (!flashCombosValides.length) { bar.style.display = 'none'; return; }
            flashComboIndex = 0;
            flashComboActif = flashCombosValides[0];
            afficherBandeauFlashCombo();
            demarrerRotationFlashCombo();
            return;
        }
        const h = Math.floor(restant / 3600000), m = Math.floor((restant % 3600000) / 60000), s = Math.floor((restant % 60000) / 1000);
        timerEl.textContent = `⏳ ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    };
    maj();
    flashComboMinuteur = setInterval(maj, 1000);
}

function ouvrirCompositionFlashCombo() {
    const o = flashComboActif;
    if (!o || !o.produit_principal) return;
    const choisis = new Set();

    const el = document.createElement('div');
    el.className = 'modal-overlay';
    el.style.cssText = 'display:flex;z-index:5500;position:fixed;inset:0;background:rgba(0,0,0,0.65);align-items:center;justify-content:center;padding:16px';

    const rendreContenu = () => {
        const sommeIndividuelle = getPrix(o.produit_principal) + [...choisis].reduce((s, id) => {
            const p = o.choix.find(c => c.id === id); return s + (p ? getPrix(p) : 0);
        }, 0);
        const economie = Math.max(0, sommeIndividuelle - o.prix_ensemble);

        el.innerHTML = `<div style="background:white;border-radius:16px;max-width:480px;width:100%;max-height:85vh;overflow-y:auto;padding:0">
            <div style="background:linear-gradient(135deg,#FF6B1A,#ff8a3d);padding:20px 22px;color:white;position:relative">
                <button onclick="this.closest('.modal-overlay').remove()" style="position:absolute;top:14px;right:14px;background:rgba(255,255,255,0.25);border:none;color:white;width:28px;height:28px;border-radius:50%;cursor:pointer">✕</button>
                <div style="font-weight:800;font-size:1.05rem">⚡ ${o.nom}</div>
                <div style="font-size:0.8rem;opacity:0.95;margin-top:2px">Choisis ${o.nb_choix_requis} accessoire(s) pour compléter ton kit</div>
            </div>
            <div style="padding:20px">
                <p style="font-size:0.76rem;color:var(--text3);background:#fff8f2;border:1px solid #ffe4cc;border-radius:10px;padding:9px 12px;margin-bottom:14px">
                    💡 <strong>Comment ça marche :</strong> le produit principal est déjà inclus. Choisis ${o.nb_choix_requis} accessoire(s) dans la liste ci-dessous, et le kit complet te revient à ${fmt(o.prix_ensemble)} FCFA au lieu du prix normal de chaque article séparément.
                </p>
                <div style="display:flex;gap:12px;align-items:center;background:#f8f8f8;border-radius:12px;padding:12px;margin-bottom:16px">
                    ${o.produit_principal.image_url ? `<img src="${o.produit_principal.image_url}" style="width:56px;height:56px;object-fit:cover;border-radius:8px">` : ''}
                    <div>
                        <div style="font-weight:700;font-size:0.88rem">${o.produit_principal.name}</div>
                        <div style="font-size:0.76rem;color:#888">Produit principal (inclus) — ${fmt(getPrix(o.produit_principal))} FCFA</div>
                    </div>
                </div>
                <p style="font-size:0.8rem;font-weight:600;margin-bottom:8px">Choisis ${o.nb_choix_requis} accessoire(s) (${choisis.size}/${o.nb_choix_requis}) :</p>
                <div style="display:grid;gap:8px;margin-bottom:16px">
                    ${o.choix.map(p => {
                        const enRupture = p.quantity <= 0;
                        const coche = choisis.has(p.id);
                        const desactive = enRupture || (!coche && choisis.size >= o.nb_choix_requis);
                        return `<label style="display:flex;align-items:center;gap:10px;padding:10px;border:1.5px solid ${coche?'#FF6B1A':'#eee'};border-radius:10px;cursor:${desactive?'not-allowed':'pointer'};opacity:${desactive?0.45:1};background:${coche?'#fff8f2':'white'}">
                            <input type="checkbox" data-produit-id="${p.id}" class="flash-combo-choix-check" ${coche?'checked':''} ${desactive?'disabled':''}>
                            ${p.image_url ? `<img src="${p.image_url}" style="width:36px;height:36px;object-fit:cover;border-radius:6px">` : ''}
                            <div style="flex:1">
                                <div style="font-size:0.82rem;font-weight:600">${p.name}</div>
                                <div style="font-size:0.72rem;color:#999">${enRupture ? 'Rupture de stock' : fmt(getPrix(p)) + ' FCFA'}</div>
                            </div>
                        </label>`;
                    }).join('')}
                </div>
                <div style="background:#f0fff4;border-radius:10px;padding:12px;margin-bottom:14px;font-size:0.85rem">
                    <div style="display:flex;justify-content:space-between;color:#888;text-decoration:line-through"><span>Prix normal</span><span>${fmt(sommeIndividuelle)} FCFA</span></div>
                    <div style="display:flex;justify-content:space-between;font-weight:800;font-size:1rem;color:#1a5c2a;margin-top:4px"><span>Prix du kit</span><span>${fmt(o.prix_ensemble)} FCFA</span></div>
                    ${economie > 0 ? `<div style="text-align:right;color:#e63946;font-size:0.76rem;font-weight:700;margin-top:2px">Tu économises ${fmt(economie)} FCFA</div>` : ''}
                </div>
                <button id="flash-combo-btn-ajouter" ${choisis.size < o.nb_choix_requis ? 'disabled' : ''} style="width:100%;background:${choisis.size < o.nb_choix_requis ? '#ccc' : 'linear-gradient(135deg,var(--green-dark),var(--green))'};color:white;border:none;padding:14px;border-radius:12px;font-weight:800;cursor:${choisis.size < o.nb_choix_requis ? 'not-allowed' : 'pointer'};font-family:var(--font-title)">
                    ${choisis.size < o.nb_choix_requis ? `Choisis encore ${o.nb_choix_requis - choisis.size} accessoire(s)` : '🛒 Ajouter le kit au panier'}
                </button>
            </div>
        </div>`;

        el.querySelectorAll('.flash-combo-choix-check').forEach(cb => {
            cb.onchange = () => {
                const id = cb.dataset.produitId;
                if (cb.checked) choisis.add(id); else choisis.delete(id);
                rendreContenu();
            };
        });
        const btn = el.querySelector('#flash-combo-btn-ajouter');
        if (btn && choisis.size >= o.nb_choix_requis) {
            btn.onclick = () => {
                panier.push({ id: o.produit_principal.id, name: o.produit_principal.name, prix: o.prix_ensemble, prix_reel: o.prix_ensemble_reel, qty: 1, image_url: o.produit_principal.image_url, combo_id: o.id, combo_nom: o.nom });
                logVisiteur('panier_ajout', o.produit_principal.id, { nom: o.produit_principal.name, combo: o.nom });
                for (const id of choisis) {
                    const p = o.choix.find(c => c.id === id);
                    panier.push({ id: p.id, name: p.name, prix: 0, prix_reel: 0, qty: 1, image_url: p.image_url, combo_id: o.id, combo_nom: o.nom });
                    logVisiteur('panier_ajout', p.id, { nom: p.name, combo: o.nom });
                }
                updatePanierBtn(); syncPanierServeur();
                el.remove();
                openPanier();
            };
        }
    };

    rendreContenu();
    document.body.appendChild(el);
}


// ===== ASSISTANT D'AIDE (conseiller IA) =====
// Toutes les réponses viennent de l'assistant (Gemini, côté serveur), qui connaît le catalogue en direct et les
// règles de la boutique. Il n'y a plus de questions-réponses écrites d'avance.
// La discussion est mémorisée dans le navigateur : jusqu'à la déconnexion pour un membre, 24 h pour un visiteur.

const chatWidgetHistorique = [];   // ce que l'assistant relit à chaque question : { role, texte }
let chatWidgetJournal = [];        // ce qui s'affiche, rejouable après un rechargement
let chatWidgetOccupe = false;

// Raccourcis proposés à l'ouverture : ils lancent directement une conversation avec l'assistant.
const CW_ACCUEIL_PUCES = [
    { libelle: '📱 Un téléphone', question: 'Je cherche un téléphone' },
    { libelle: '🔌 Chargeur / batterie', question: 'Je cherche un chargeur ou une batterie externe' },
    { libelle: '🎧 Écouteurs', question: 'Je cherche des écouteurs' },
    { libelle: '🔥 Les promos', question: 'Quelles sont vos promos en ce moment ?' },
    { libelle: '🚚 Livraison', question: 'Comment fonctionne la livraison ?' },
    { libelle: '💳 Paiement', question: 'Comment je peux payer ma commande ?' },
    { libelle: '📦 Suivre ma commande', question: 'Comment suivre ma commande ?' }
];

// ----- Mémoire de la discussion -----
const CW_MEMOIRE_VISITEUR_MS = 24 * 3600 * 1000;
const CW_MEMOIRE_MEMBRE_MS = 30 * 24 * 3600 * 1000;
const chatWidgetEstMembre = () => typeof currentUser !== 'undefined' && !!currentUser && !!currentUser.id;
const chatWidgetCle = () => 'kap_chat_' + (chatWidgetEstMembre() ? currentUser.id : 'invite');

function chatWidgetSauver() {
    try {
        localStorage.setItem(chatWidgetCle(), JSON.stringify({
            t: Date.now(), membre: chatWidgetEstMembre(),
            j: chatWidgetJournal.slice(-80), h: chatWidgetHistorique.slice(-14)
        }));
    } catch (e) { /* stockage plein ou navigation privée : la discussion reste visible mais ne sera pas retrouvée */ }
}
function chatWidgetCharger() {
    try {
        const brut = localStorage.getItem(chatWidgetCle());
        if (!brut) return null;
        const o = JSON.parse(brut);
        const limite = o.membre ? CW_MEMOIRE_MEMBRE_MS : CW_MEMOIRE_VISITEUR_MS;
        if (!o.t || Date.now() - o.t > limite || !Array.isArray(o.j)) { localStorage.removeItem(chatWidgetCle()); return null; }
        return o;
    } catch (e) { return null; }
}
// Appelée à la déconnexion (et par le bouton ↺ « Nouvelle discussion ») : efface la mémoire ET l'écran.
function chatWidgetEffacerMemoire() {
    try { localStorage.removeItem(chatWidgetCle()); localStorage.removeItem('kap_chat_invite'); } catch (e) { /* on ignore */ }
    chatWidgetJournal = [];
    chatWidgetHistorique.length = 0;
    const zone = $('chat-widget-messages');
    if (zone) zone.textContent = '';
}
function chatWidgetNoter(evenement) { chatWidgetJournal.push(evenement); chatWidgetSauver(); }

// ----- Affichage (le paramètre « rejeu » sert à reconstituer l'écran sans re-mémoriser) -----
function chatWidgetAjouterBulle(texte, type, rejeu) {
    const zone = $('chat-widget-messages');
    const bulle = document.createElement('div');
    bulle.className = 'cw-bulle ' + (type === 'user' ? 'cw-user' : 'cw-bot');
    bulle.textContent = texte;
    zone.appendChild(bulle);
    zone.scrollTop = zone.scrollHeight;
    if (!rejeu) chatWidgetNoter({ k: type === 'user' ? 'user' : 'bot', t: texte });
    return bulle;
}

// Puces de réponse rapide (celles de l'accueil, ou celles proposées par l'assistant après chaque réponse).
function chatWidgetAfficherPuces(liste, rejeu) {
    const zone = $('chat-widget-messages');
    const bloc = document.createElement('div');
    bloc.className = 'cw-suggestions';
    liste.forEach(item => {
        const btn = document.createElement('button');
        btn.className = 'cw-suggestion-btn';
        btn.textContent = item.libelle;
        btn.onclick = () => {
            bloc.remove();
            chatWidgetJournal = chatWidgetJournal.filter(e => e.k !== 'puces');
            chatWidgetPoserQuestion(item.question);
        };
        bloc.appendChild(btn);
    });
    zone.appendChild(bloc);
    zone.scrollTop = zone.scrollHeight;
    if (!rejeu) chatWidgetNoter({ k: 'puces', l: liste });
}

function chatWidgetLienWhatsApp(texteMessage, libelle, rejeu) {
    const zone = $('chat-widget-messages');
    const lien = document.createElement('a');
    lien.href = `https://wa.me/${CONFIG.WA1}?text=${encodeURIComponent(texteMessage)}`;
    lien.target = '_blank';
    lien.rel = 'noopener';
    lien.className = 'cw-suggestion-btn';
    lien.style.display = 'block';
    lien.style.textAlign = 'center';
    lien.style.textDecoration = 'none';
    lien.textContent = libelle || '📱 Continuer sur WhatsApp';
    zone.appendChild(lien);
    zone.scrollTop = zone.scrollHeight;
    if (!rejeu) chatWidgetNoter({ k: 'wa', t: texteMessage, l: libelle || '' });
}

// Résumé prêt à envoyer à l'équipe : le client n'a pas à tout réexpliquer.
function chatWidgetResume() {
    const lignes = chatWidgetHistorique.slice(-6).map(t => (t.role === 'user' ? 'Client : ' : 'Assistant : ') + t.texte);
    return ('Bonjour Kapmaket, je viens de l\'assistant du site. Voici notre échange :\n' + lignes.join('\n')).slice(0, 900);
}

function chatWidgetAfficherProduits(cartes, rejeu) {
    const zone = $('chat-widget-messages');
    (cartes || []).forEach(p => {
        const a = document.createElement('a');
        a.className = 'cw-produit';
        a.href = p.url;
        if (p.image) {
            const img = document.createElement('img');
            img.className = 'cw-produit-img';
            img.src = p.image;
            img.alt = '';
            img.loading = 'lazy';
            a.appendChild(img);
        }
        const texte = document.createElement('span');
        texte.className = 'cw-produit-texte';
        const nom = document.createElement('span');
        nom.className = 'cw-produit-nom';
        nom.textContent = p.nom;
        const prix = document.createElement('span');
        prix.className = 'cw-produit-prix';
        prix.textContent = fmt(p.prix) + ' FCFA' + (p.enStock ? '' : ' · indisponible');
        const cta = document.createElement('span');
        cta.className = 'cw-produit-cta';
        cta.textContent = 'Voir le produit →';
        texte.appendChild(nom);
        texte.appendChild(prix);
        texte.appendChild(cta);
        a.appendChild(texte);
        zone.appendChild(a);
    });
    zone.scrollTop = zone.scrollHeight;
    if (!rejeu && cartes && cartes.length) chatWidgetNoter({ k: 'cartes', c: cartes });
}

function chatWidgetRejouer(journal) {
    journal.forEach((e, i) => {
        if (e.k === 'user' || e.k === 'bot') chatWidgetAjouterBulle(e.t, e.k, true);
        else if (e.k === 'cartes') chatWidgetAfficherProduits(e.c, true);
        else if (e.k === 'wa') chatWidgetLienWhatsApp(e.t, e.l, true);
        else if (e.k === 'puces' && i === journal.length - 1) chatWidgetAfficherPuces(e.l, true); // seulement si c'est la dernière chose affichée
    });
}

// Ouverture : on retrouve la discussion en cours, sinon message d'accueil + raccourcis.
function chatWidgetAccueil() {
    const memoire = chatWidgetCharger();
    if (memoire && memoire.j.length) {
        chatWidgetJournal = memoire.j;
        (memoire.h || []).forEach(t => chatWidgetHistorique.push(t));
        chatWidgetRejouer(chatWidgetJournal);
        return;
    }
    chatWidgetAjouterBulle("👋 Salut ! Je suis l'assistant Kapmaket. Dis-moi ce que tu cherches et je te propose ce qu'on a en stock. Tu peux aussi me poser une question sur la livraison, le paiement ou ta commande. Tes questions, sans ton nom ni ton numéro, nous aident à améliorer la boutique.", 'bot');
    chatWidgetAfficherPuces(CW_ACCUEIL_PUCES);
}

// ----- Appel à l'assistant (Gemini, côté serveur) -----
async function chatWidgetDemanderIA(texte) {
    chatWidgetOccupe = true;
    const bulle = chatWidgetAjouterBulle('…', 'bot', true); // simple indicateur : pas mémorisé
    let refPanne = 'réseau';
    const secours = () => {
        const msg = "Oups, je n'arrive pas à répondre pour l'instant 😕 (réf. " + refPanne + ") Écris-nous directement, on te répond vite :";
        bulle.textContent = msg;
        chatWidgetNoter({ k: 'bot', t: msg });
        chatWidgetLienWhatsApp(chatWidgetResume());
    };
    try {
        const ctrl = new AbortController();
        const minuteur = setTimeout(() => ctrl.abort(), 20000);
        const r = await fetch('/api/recherche-photo?mode=assistant', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: texte, historique: chatWidgetHistorique.slice(-9, -1), session: typeof visiteurId !== 'undefined' ? visiteurId : '' }),
            signal: ctrl.signal
        });
        clearTimeout(minuteur);
        refPanne = 'HTTP ' + r.status;
        const j = await r.json().catch(() => ({}));
        if (!j.reponse) { secours(); return; }
        bulle.textContent = j.reponse;
        chatWidgetHistorique.push({ role: 'bot', texte: j.reponse });
        chatWidgetNoter({ k: 'bot', t: j.reponse });
        if (j.repli) { chatWidgetLienWhatsApp(chatWidgetResume()); return; }
        chatWidgetAfficherProduits(j.produits);
        if (j.humain) chatWidgetLienWhatsApp(chatWidgetResume(), '📱 Parler à l\'équipe sur WhatsApp');
        if (j.suggestions && j.suggestions.length) chatWidgetAfficherPuces(j.suggestions.map(s => ({ libelle: s, question: s })));
    } catch (e) {
        secours();
    } finally {
        chatWidgetOccupe = false;
        const zone = $('chat-widget-messages');
        zone.scrollTop = zone.scrollHeight;
    }
}

function chatWidgetPoserQuestion(texteAffiche) {
    if (chatWidgetOccupe) return;
    cwEcrire('kap_assistant_utilise', 1); // elle a découvert l'assistant : l'invitation s'arrête
    chatWidgetHistorique.push({ role: 'user', texte: texteAffiche }); // avant l'affichage : la mémoire sauvegardée est complète
    chatWidgetAjouterBulle(texteAffiche, 'user');
    chatWidgetDemanderIA(texteAffiche);
}

// Invitation de l'assistant : un petit message au-dessus du bouton 💬, pour que le visiteur découvre qu'il a un assistant.
// Elle revient à CHAQUE VISITE (retour sur le site après 30 minutes d'absence), pendant 30 jours à partir de son premier
// affichage, avec un texte différent d'une visite à l'autre. Elle s'arrête :
//   - dès que la personne a posé une question à l'assistant (elle l'a découvert) ;
//   - après 3 refus (« Non merci » / « Plus tard ») ;
//   - jamais dans l'espace administrateur.
const CW_INVITATION_JOURS = 30;                  // durée pendant laquelle elle revient (modifiable ici)
const CW_INVITATION_ECART_MS = 30 * 60 * 1000;   // 2 affichages à moins de 30 min = la même visite
const CW_INVITATION_REFUS_MAX = 3;
const cwLire = (cle) => { try { return Number(localStorage.getItem(cle)) || 0; } catch (e) { return 0; } };
const cwEcrire = (cle, valeur) => { try { localStorage.setItem(cle, String(valeur)); } catch (e) { /* navigation privée : on ignore */ } };

const CW_INVITATIONS = [
    (p) => ({ titre: p ? '👋 ' + p + ', besoin d\'aide pour choisir ?' : '👋 Besoin d\'aide pour choisir ?', sous: 'Laisse-toi accompagner par notre assistant : dis-lui ce que tu cherches, il te propose ce qu\'on a en stock.', oui: 'Oui, aide-moi', non: 'Non merci' }),
    () => ({ titre: '💬 Une question ? Demande-moi tout', sous: 'Produits, livraison, paiement, suivi de commande : notre assistant connaît tout le site. Laisse-toi guider.', oui: 'Je pose ma question', non: 'Plus tard' }),
    () => ({ titre: '🔎 Tu ne trouves pas ce que tu cherches ?', sous: 'Dis-le à notre assistant : il cherche dans tout le catalogue pour toi et te propose les produits disponibles.', oui: 'Essayer l\'assistant', non: 'Non merci' })
];

function chatWidgetInvitationFermer(refus) {
    const bloc = document.getElementById('chat-invite');
    if (bloc) bloc.remove();
    if (refus) cwEcrire('kap_invite_refus', cwLire('kap_invite_refus') + 1);
}
function chatWidgetInvitationAfficher({ titre, sous, oui, non }) {
    const panel = $('chat-widget-panel');
    if (!panel || panel.style.display === 'flex') return;
    const ancien = document.getElementById('chat-invite');
    if (ancien) ancien.remove();
    const bloc = document.createElement('div');
    bloc.id = 'chat-invite';
    bloc.setAttribute('role', 'dialog');
    bloc.setAttribute('aria-label', 'Invitation à utiliser l\'assistant');
    const t = document.createElement('div');
    t.className = 'ci-titre';
    t.textContent = titre;
    const st = document.createElement('div');
    st.className = 'ci-sous';
    st.textContent = sous;
    const rang = document.createElement('div');
    rang.className = 'ci-boutons';
    const bOui = document.createElement('button');
    bOui.className = 'ci-oui';
    bOui.textContent = oui;
    bOui.onclick = () => { chatWidgetInvitationFermer(); $('chat-widget-btn').click(); };
    const bNon = document.createElement('button');
    bNon.className = 'ci-non';
    bNon.textContent = non;
    bNon.onclick = () => chatWidgetInvitationFermer(true);
    rang.appendChild(bOui);
    rang.appendChild(bNon);
    bloc.appendChild(t);
    bloc.appendChild(st);
    bloc.appendChild(rang);
    document.body.appendChild(bloc);
    setTimeout(() => { if (document.getElementById('chat-invite')) chatWidgetInvitationFermer(); }, 25000);
}
function chatWidgetInvitationAutorisee() {
    if (cwLire('kap_assistant_utilise')) return false;
    if (cwLire('kap_invite_refus') >= CW_INVITATION_REFUS_MAX) return false;
    const maintenant = Date.now(), debut = cwLire('kap_invite_debut'), dernier = cwLire('kap_invite_dernier');
    if (debut && maintenant - debut > CW_INVITATION_JOURS * 24 * 3600 * 1000) return false;
    if (dernier && maintenant - dernier < CW_INVITATION_ECART_MS) return false;
    return true;
}
function chatWidgetInvitation() {
    if (!chatWidgetInvitationAutorisee()) return;
    setTimeout(() => {
        if (!chatWidgetInvitationAutorisee()) return; // la situation a pu changer pendant l'attente
        if (document.getElementById('bienvenue-overlay')) return; // le message de bienvenue est à l'écran : on ne l'encombre pas
        const nb = cwLire('kap_invite_nb');
        const prenom = (typeof currentUser !== 'undefined' && currentUser && currentUser.nom) ? String(currentUser.nom).trim().split(/\s+/)[0] : '';
        chatWidgetInvitationAfficher(CW_INVITATIONS[nb % CW_INVITATIONS.length](prenom));
        if (document.getElementById('chat-invite')) { // affichée pour de bon (le chat n'était pas déjà ouvert)
            const maintenant = Date.now();
            if (!cwLire('kap_invite_debut')) cwEcrire('kap_invite_debut', maintenant);
            cwEcrire('kap_invite_dernier', maintenant);
            cwEcrire('kap_invite_nb', nb + 1);
        }
    }, 6000);
}


function setupChatWidget() {
    // En-tête : bouton « Nouvelle discussion » et sous-titre à jour (sans toucher à index.html).
    const entete = $('chat-widget-header'), fermer = $('chat-widget-close');
    if (entete && fermer && entete.insertBefore && !$('chat-widget-reset')) {
        const sous = entete.children && entete.children[0] && entete.children[0].children && entete.children[0].children[1];
        if (sous) sous.textContent = 'Je connais tout le catalogue';
        const groupe = document.createElement('div');
        groupe.style.cssText = 'display:flex;gap:8px;align-items:center';
        const reset = document.createElement('button');
        reset.id = 'chat-widget-reset';
        reset.textContent = '↺';
        reset.title = 'Nouvelle discussion';
        reset.setAttribute('aria-label', 'Nouvelle discussion');
        reset.onclick = () => { chatWidgetEffacerMemoire(); chatWidgetAccueil(); };
        entete.insertBefore(groupe, fermer);
        groupe.appendChild(reset);
        groupe.appendChild(fermer);
    }

    // Pied de fenêtre : transparence sur l'IA et lien vers la politique de confidentialité.
    const rangSaisie = $('chat-widget-input-row');
    if (rangSaisie && rangSaisie.parentNode && !$('chat-widget-pied')) {
        const pied = document.createElement('div');
        pied.id = 'chat-widget-pied';
        pied.className = 'cw-pied';
        pied.appendChild(document.createTextNode('🤖 Assistant virtuel (IA) : il peut se tromper, le prix final est celui du panier. '));
        const lien = document.createElement('a');
        lien.href = '#';
        lien.textContent = 'Confidentialité';
        lien.onclick = e => { e.preventDefault(); openOverlay('politique-overlay'); };
        pied.appendChild(lien);
        rangSaisie.parentNode.insertBefore(pied, rangSaisie);
    }

    const basculer = (ouvrir) => {
        $('chat-widget-panel').style.display = ouvrir ? 'flex' : 'none';
        if (document.body.classList) document.body.classList.toggle('cw-ouvert', ouvrir); // mobile : la page derrière ne défile pas
        const zone = $('chat-widget-messages');
        if (ouvrir && zone.children.length === 0) chatWidgetAccueil();
        if (ouvrir) {
            zone.scrollTop = zone.scrollHeight;
            const grand = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(min-width: 700px)').matches;
            const champ = $('chat-widget-input');
            if (grand && champ && champ.focus) champ.focus();
        }
    };
    $('chat-widget-btn').onclick = () => {
        chatWidgetInvitationFermer();
        basculer($('chat-widget-panel').style.display !== 'flex');
    };
    $('chat-widget-close').onclick = () => basculer(false);

    const envoyer = () => {
        const input = $('chat-widget-input');
        const texte = input.value.trim();
        if (!texte) return;
        input.value = '';
        chatWidgetPoserQuestion(texte);
    };
    $('chat-widget-send').onclick = envoyer;
    $('chat-widget-input').onkeydown = e => { if (e.key === 'Enter') envoyer(); };
    chatWidgetInvitation();
}


// ===== FAVORIS =====
// Appel authentifié vers /api/mon-profil (jeton Firebase vérifié côté serveur).
// Sert au panier et aux favoris, qui ne sont plus accessibles avec la clé publique.
async function appelCompte(methode, ressource, corps) {
    const fbUser = await attendreFirebaseUser();
    if (!fbUser) throw new Error('Non connecté');
    const idToken = await fbUser.getIdToken();
    const resp = await fetch('/api/mon-profil' + (ressource ? '?ressource=' + ressource : ''), {
        method: methode,
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
        body: corps ? JSON.stringify(corps) : undefined
    });
    const j = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(j.error || ('Erreur ' + resp.status));
    return j;
}

async function chargerFavoris() {
    if (!currentUser) return;
    try {
        const j = await appelCompte('GET', 'favoris');
        favorisIds = new Set(j.favoris || []);
        if (allProducts.length) renderProducts(allProducts);
    } catch (e) { console.error('Erreur chargement favoris :', e.message || e); }
}

window.toggleFavori = async (productId, btn) => {
    if (!currentUser) { openOverlay('auth-overlay'); return; }
    const estFavori = favorisIds.has(productId);
    // Affichage immédiat (le Set est mis à jour avant tout await : le reste de
    // l'interface le relit tout de suite), puis enregistrement côté serveur.
    if (estFavori) favorisIds.delete(productId); else favorisIds.add(productId);
    if (btn) { btn.textContent = estFavori ? '🤍' : '❤️'; btn.classList.toggle('active', !estFavori); }
    try {
        await appelCompte('POST', null, { action: estFavori ? 'favori_retirer' : 'favori_ajouter', product_id: productId });
    } catch (e) {
        // Échec : on remet l'état d'avant pour ne pas afficher un favori qui n'est pas enregistré.
        if (estFavori) favorisIds.add(productId); else favorisIds.delete(productId);
        if (btn) { btn.textContent = estFavori ? '❤️' : '🤍'; btn.classList.toggle('active', estFavori); }
        console.error('Erreur favori :', e.message || e);
    }
};

function afficherFavoris() {
    const favs = allProducts.filter(p => favorisIds.has(p.id));
    currentCat = 'tous';
    finRecherche(true);
    renderProducts(favs);
    $('produits').scrollIntoView({behavior:'smooth'});
}

// ===== MOT DE PASSE OUBLIE =====
function setupResetPassword() {
    $('btn-mdp-oublie').onclick = () => {
        closeOverlay('auth-overlay');
        $('reset-email').value = '';
        $('reset-err1').textContent = ''; $('reset-err1').style.color = 'var(--danger)';
        openOverlay('reset-overlay');
    };
    $('reset-close').onclick = () => closeOverlay('reset-overlay');
    $('reset-overlay').onclick = e => { if (e.target === $('reset-overlay')) closeOverlay('reset-overlay'); };
    $('btn-reset-envoyer').onclick = envoyerLienReset;
    $('btn-confirm-reset').onclick = confirmerNouveauMdpDepuisEmail;
}

async function envoyerLienReset() {
    const email = $('reset-email').value.trim();
    const err = $('reset-err1');
    err.style.color = 'var(--danger)'; err.textContent = '';
    if (!email.includes('@')) { err.textContent = '❌ Adresse email invalide'; return; }
    $('btn-reset-envoyer').textContent = 'Envoi...'; $('btn-reset-envoyer').disabled = true;
    try {
        // Le lien dans l'email renvoie sur notre propre domaine (au lieu d'une page firebaseapp.com brute)
        await window.fbSendPasswordResetEmail(window.firebaseAuth, email, {
            url: window.location.origin + '/',
            handleCodeInApp: true
        });
        err.style.color = 'var(--success)';
        err.textContent = '✅ Email envoyé à ' + email + ' — clique sur le lien pour choisir un nouveau mot de passe. Tu ne le vois pas dans quelques minutes ? Pense à vérifier tes spams/indésirables.';
    } catch (e) {
        err.textContent = '❌ ' + traduireErreurFirebase(e);
    }
    $('btn-reset-envoyer').textContent = 'Envoyer le lien'; $('btn-reset-envoyer').disabled = false;
}

// Traite le retour du lien de réinitialisation (arrivée sur notre propre domaine avec ?oobCode=...)
let resetOobCode = null;
async function verifierLienResetDansURL() {
    const codeInfos = new URLSearchParams(window.location.search).get('infos');
    if (codeInfos) { window.history.replaceState({}, '', window.location.pathname); setTimeout(() => ouvrirInfosLivraison(codeInfos), 1200); }
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') !== 'resetPassword' || !params.get('oobCode')) return;
    resetOobCode = params.get('oobCode');
    try {
        await window.fbVerifyPasswordResetCode(window.firebaseAuth, resetOobCode);
        openOverlay('confirm-reset-overlay');
    } catch (e) {
        notifier('❌ Ce lien de réinitialisation est invalide ou expiré. Redemandez-en un.', 'erreur');
    }
    // Nettoie l'URL pour ne pas garder le code affiché
    window.history.replaceState({}, '', window.location.pathname);
}

async function confirmerNouveauMdpDepuisEmail() {
    const mdp1 = $('confirm-reset-mdp1').value.trim();
    const mdp2 = $('confirm-reset-mdp2').value.trim();
    const err = $('confirm-reset-err');
    err.textContent = '';
    if (mdp1.length < 6) { err.textContent = '❌ Mot de passe trop court (6 min)'; return; }
    if (mdp1 !== mdp2) { err.textContent = '❌ Mots de passe différents'; return; }
    $('btn-confirm-reset').textContent = 'Validation...'; $('btn-confirm-reset').disabled = true;
    try {
        await window.fbConfirmPasswordReset(window.firebaseAuth, resetOobCode, mdp1);
        closeOverlay('confirm-reset-overlay');
        notifier('✅ Mot de passe changé ! Tu peux te connecter.', 'succes');
        openOverlay('auth-overlay');
    } catch (e) {
        err.textContent = '❌ ' + traduireErreurFirebase(e);
    }
    $('btn-confirm-reset').textContent = 'Valider le nouveau mot de passe'; $('btn-confirm-reset').disabled = false;
}


// ===== BANNIÈRE =====
async function chargerBanniere() {
    const { data } = await db.from('bannières').select('*').eq('actif', true).eq('type', 'banniere');
    if (!data || !data.length) return;
    const txt = data.map(b => '📢 ' + b.message).join('   •   ');
    $('banniere-text').textContent = txt + '   •   ' + txt;
    $('banniere-top').style.display = 'block';
}

// ===== POPUP =====
async function afficherPopup() {
    const { data: msgs } = await db.from('bannières').select('*').eq('actif', true).eq('type', 'popup');
    const popupMsg = msgs?.[0];

    let vitrine = [];
    if (popupMsg?.produits_ids?.length) {
        const { data: choisis } = await db.from('products').select('*').in('id', popupMsg.produits_ids);
        vitrine = choisis || [];
    } else {
        const { data: flash } = await db.from('products').select('*').eq('flash_active', true).limit(4);
        vitrine = flash || [];
    }
    if (!popupMsg && !vitrine.length) return;

    const msg = popupMsg?.message || '🎉 Bienvenue sur Kapmaket !';
    const titreVitrine = popupMsg?.produits_ids?.length ? '🛍️ Sélection du moment' : '⚡ Ventes Flash';
    const flyerHtml = popupMsg?.image_url
        ? `<img src="${popupMsg.image_url}" alt="Offre spéciale Kapmaket" ${popupMsg.lien ? `onclick="closePopup();window.open('${popupMsg.lien}','_blank')" style="cursor:pointer;` : 'style="'}width:100%;border-radius:12px;margin-bottom:14px;display:block">`
        : `<img src="/logo-panier.png" alt="Logo Kapmaket" style="height:55px;width:55px;border-radius:50%;margin-bottom:12px">`;
    const prods = vitrine.length ? `<p style="font-weight:700;color:var(--orange-text);margin:14px 0 8px">${titreVitrine}</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
        ${vitrine.map(p=>`<div onclick="closePopup();openModal('${p.id}')" style="background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:10px;cursor:pointer;text-align:center">
            ${p.image_url?`<img src="${p.image_url}" alt="${p.name}" style="width:100%;height:55px;object-fit:cover;border-radius:6px;margin-bottom:6px">`:''}
            <div style="font-size:0.75rem;font-weight:600">${p.name}</div>
            <div style="font-size:0.8rem;color:var(--orange-text);font-weight:700">${fmt(getPrix(p))} F</div>
        </div>`).join('')}</div>` : '';
    const el = document.createElement('div');
    el.id = 'popup-overlay';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(4px)';
    el.innerHTML = `<div style="background:var(--card);border-radius:18px;padding:28px;max-width:400px;width:100%;text-align:center;position:relative;max-height:90vh;overflow-y:auto">
        <button onclick="closePopup()" style="position:absolute;top:12px;right:12px;background:rgba(255,255,255,0.9);border:none;border-radius:50%;width:30px;height:30px;cursor:pointer;font-size:0.9rem;color:var(--text);z-index:1">✕</button>
        ${flyerHtml}
        ${!popupMsg?.image_url ? `<h2 style="font-family:Poppins,sans-serif;color:var(--green);margin-bottom:8px">Kapmaket</h2>` : ''}
        <p style="color:var(--text2);line-height:1.6;margin-bottom:10px">${msg}</p>
        ${prods}
        <button onclick="closePopup()" style="background:var(--green);color:white;border:none;padding:12px 28px;border-radius:10px;font-weight:700;cursor:pointer;font-size:0.95rem;font-family:Inter,sans-serif">Explorer →</button>
    </div>`;
    document.body.appendChild(el);
}
window.closePopup = () => { const el = $('popup-overlay'); if(el) el.remove(); };

// ===== SLIDER =====
function initSlider(slidesData) {
    const track = $('slider-track');
    const dots = $('slider-dots');
    track.innerHTML = '';
    dots.innerHTML = '';
    totalSlides = slidesData && slidesData.length > 0 ? slidesData.length : 1;

    if (slidesData && slidesData.length > 0) {
        slidesData.forEach((s, i) => {
            const slide = document.createElement('div');
            slide.className = 'slide';
            if (s.image_url) {
                const prixHtml = s.prix_actuel ? `<div class="slide-prix-bloc">
                    <span class="slide-prix-actuel">${fmt(prixCharme(s.prix_actuel))} FCFA</span>
                    ${s.prix_ancien ? `<span class="slide-prix-ancien">${fmt(s.prix_ancien)} FCFA</span>` : ''}
                </div>` : '';
                slide.innerHTML = `<div class="slide-inner">
                    <div class="slide-tag">${s.tag||'🔥 PROMO'}</div>
                    <h2>${s.titre||''}<br><span>${s.sous_titre||''}</span></h2>
                    <p>${s.message||''}</p>
                    ${prixHtml}
                    ${s.btn_texte?`<button class="slide-btn" onclick="${s.produit_id ? `openModal('${s.produit_id}')` : `document.getElementById('produits').scrollIntoView({behavior:'smooth'})`}">${s.btn_texte}</button>`:''}
                    <div class="slide-atouts">
                        <span>🚚 Livraison rapide</span>
                        <span>💳 Paiement sécurisé</span>
                        <span>✅ Produits authentiques</span>
                    </div>
                </div>
                <div class="slide-media"><div class="slide-halo"></div><img src="${srcMini(s.image_url)}" data-orig="${s.image_url}" onerror="this.onerror=null;this.src=this.dataset.orig" class="slide-product-img img-blurup" width="260" height="260" ${i === 0 ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'} decoding="async" onload="this.classList.add('loaded')" alt="${s.titre||'Promotion'}"></div>`;
            } else {
                slide.className = 'slide slide-default';
                slide.innerHTML = `<div class="slide-inner slide-inner-full">
                    <div class="slide-tag">🔥 BIENVENUE</div>
                    <h2>Les meilleurs produits<br><span>Tech au Cameroun</span></h2>
                    <p>Livraison rapide à Douala • Qualité garantie</p>
                    <button class="slide-btn" onclick="$('produits').scrollIntoView({behavior:'smooth'})">Découvrir →</button>
                </div>`;
            }
            track.appendChild(slide);
            const dot = document.createElement('button');
            dot.className = 'slider-dot' + (i===0?' active':'');
            dot.setAttribute('aria-label', `Aller à la diapositive ${i+1}`);
            dot.onclick = () => goSlide(i);
            dots.appendChild(dot);
        });
    } else {
        const slide = document.createElement('div');
        slide.className = 'slide slide-default';
        slide.innerHTML = `<div class="slide-inner slide-inner-full">
            <div class="slide-tag">🔥 BIENVENUE</div>
            <h2>Les meilleurs produits<br><span>Tech au Cameroun</span></h2>
            <p>Livraison rapide à Douala • Qualité garantie</p>
            <button class="slide-btn" id="slide-decouvrir">Découvrir →</button>
        </div>`;
        track.appendChild(slide);
        const dot = document.createElement('button');
        dot.className = 'slider-dot active';
        dot.setAttribute('aria-label', 'Aller à la diapositive 1');
        dots.appendChild(dot);
        const btn = document.getElementById('slide-decouvrir');
        if (btn) btn.onclick = () => $('produits').scrollIntoView({behavior:'smooth'});
    }

    if (slideTimer) clearInterval(slideTimer);
    if (totalSlides > 1) slideTimer = setInterval(() => { if (!window._enteteEnMouvement) goSlide((slideIndex+1) % totalSlides); }, 3200);

    $('slider-prev').onclick = () => goSlide((slideIndex - 1 + totalSlides) % totalSlides);
    $('slider-next').onclick = () => goSlide((slideIndex + 1) % totalSlides);
    $('slide-btn-decouvrir') && ($('slide-btn-decouvrir').onclick = () => $('produits').scrollIntoView({behavior:'smooth'}));
}

function goSlide(i) {
    slideIndex = i;
    $('slider-track').style.transform = `translateX(-${i * 100}%)`;
    document.querySelectorAll('.slider-dot').forEach((d, j) => d.classList.toggle('active', j === i));
}

// ===== CATÉGORIES =====
function setupCategories() {
    document.querySelectorAll('.cat-pill').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            finRecherche(true);
            currentCat = btn.dataset.cat;
            logVisiteur('filtre_categorie', currentCat);
            renderProducts(allProducts);
            $('produits').scrollIntoView({behavior:'smooth'});
        };
    });

    document.querySelectorAll('.tuile').forEach(t => {
        t.onclick = () => {
            if (t.dataset.action === 'flash') { filtrerFlash(); return; }
            filtrerCat(t.dataset.cat);
        };
    });
}

function filtrerCat(cat) {
    finRecherche(true);
    currentCat = cat;
    logVisiteur('filtre_categorie', cat);
    document.querySelectorAll('.cat-pill').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
    renderProducts(allProducts);
    $('produits').scrollIntoView({behavior:'smooth'});
}

// ===== MODE RECHERCHE =====
// Pendant une recherche, slider / tuiles / catégories / Ventes Flash sont masqués (CSS : body.mode-recherche).
function normRecherche(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s\-_.,'’\/]+/g, ''); }
function filtrerParRecherche(liste, brut) {
    const q = normRecherche(brut);
    if (!q) return liste;
    return liste.filter(p => normRecherche(p.name).includes(q) || normRecherche(p.description).includes(q) || normRecherche(p.category).includes(q));
}
function majModeRecherche(actif) { document.body.classList.toggle('mode-recherche', !!actif); }
function finRecherche(vider) {
    _requeteRecherche = '';
    majModeRecherche(false);
    if (vider) {
        const c = document.getElementById('search-bar'); if (c) c.value = '';
        if (typeof fermerSuggestions === 'function') fermerSuggestions();
    }
}

// ===== AUTOCOMPLÉTION =====
// Liste de suggestions sous la barre : produits (photo, nom, prix), recherches récentes (mémorisées
// uniquement sur l'appareil du client) et « Vouliez-vous dire » en cas de faute de frappe.
const RECENTES_CLE = 'cmkt_recherches_recentes';
function lireRecentes() {
    try { const v = JSON.parse(localStorage.getItem(RECENTES_CLE) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x).slice(0, 5) : []; } catch (e) { return []; }
}
function ecrireRecentes(l) { try { localStorage.setItem(RECENTES_CLE, JSON.stringify(l.slice(0, 5))); } catch (e) {} }
function memoriserRecherche(t) {
    t = (t || '').trim().slice(0, 60);
    if (normRecherche(t).length < 2) return;
    ecrireRecentes([t, ...lireRecentes().filter(x => normRecherche(x) !== normRecherche(t))]);
}
const sansAccents = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function motsDe(s) { return (s || '').split(/[\s\-_.,'’\/()]+/).filter(Boolean); }
function distanceEdition(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 99;
    const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let diag = prev[0]; prev[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j];
            prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
            diag = tmp;
        }
    }
    return prev[b.length];
}
// Produits qui correspondent, les meilleurs d'abord : nom qui commence par la saisie, mot du nom, nom, catégorie, description
function suggestionsProduits(brut) {
    const q = normRecherche(brut);
    if (q.length < 2) return [];
    const trouves = [];
    allProducts.forEach(p => {
        const nom = normRecherche(p.name);
        let score;
        if (nom.startsWith(q)) score = 0;
        else if (motsDe(p.name).some(m => normRecherche(m).startsWith(q))) score = 1;
        else if (nom.includes(q)) score = 2;
        else if (normRecherche(p.category).includes(q)) score = 3;
        else if (normRecherche(p.description).includes(q)) score = 4;
        else return;
        trouves.push({ p, score });
    });
    trouves.sort((a, b) => a.score - b.score || String(a.p.name).localeCompare(String(b.p.name), 'fr'));
    return trouves.map(x => x.p);
}
// Mot du catalogue le plus proche d'une saisie sans résultat (une ou deux lettres de différence)
function motProche(brut) {
    const q = normRecherche(brut);
    if (q.length < 4 || /\s/.test((brut || '').trim())) return null;
    const seuil = q.length >= 7 ? 2 : 1;
    let meilleur = null;
    const vus = new Set();
    allProducts.forEach(p => motsDe(p.name).forEach(m => {
        const n = normRecherche(m);
        if (n.length < 3 || vus.has(n)) return;
        vus.add(n);
        const d = Math.min(distanceEdition(q, n), n.length > q.length ? distanceEdition(q, n.slice(0, q.length)) : 99);
        if (d <= seuil && (!meilleur || d < meilleur.d || (d === meilleur.d && n.length < meilleur.n.length))) meilleur = { d, n, m };
    }));
    return meilleur ? meilleur.m : null;
}
function fragmentSurligne(texte, brut) {
    const f = document.createDocumentFragment();
    const t = String(texte || '');
    const sa = sansAccents(t).toLowerCase();
    const cherche = sansAccents(brut).toLowerCase();
    const i = (cherche && sa.length === t.length) ? sa.indexOf(cherche) : -1;
    if (i < 0) { f.appendChild(document.createTextNode(t)); return f; }
    f.appendChild(document.createTextNode(t.slice(0, i)));
    const b = document.createElement('b'); b.textContent = t.slice(i, i + cherche.length); f.appendChild(b);
    f.appendChild(document.createTextNode(t.slice(i + cherche.length)));
    return f;
}
function setupAutocomplete() {
    const champ = $('search-bar'), boite = $('search-suggest');
    if (!champ || !boite) return;
    let actif = -1;
    const en = () => currentLang === 'en';
    champ.setAttribute('role', 'combobox');
    champ.setAttribute('aria-autocomplete', 'list');
    champ.setAttribute('aria-controls', 'search-suggest');
    champ.setAttribute('aria-expanded', 'false');
    const items = () => Array.from(boite.querySelectorAll('.ss-item'));
    function fermer() {
        boite.hidden = true; boite.innerHTML = ''; actif = -1;
        champ.setAttribute('aria-expanded', 'false'); champ.removeAttribute('aria-activedescendant');
    }
    window.fermerSuggestions = fermer;
    function choisir(i) {
        const l = items();
        l.forEach(x => x.classList.remove('actif'));
        actif = i;
        if (i >= 0 && l[i]) { l[i].classList.add('actif'); l[i].scrollIntoView({ block: 'nearest' }); champ.setAttribute('aria-activedescendant', l[i].id); }
        else champ.removeAttribute('aria-activedescendant');
    }
    function titre(txt) { const d = document.createElement('div'); d.className = 'ss-titre'; d.textContent = txt; boite.appendChild(d); }
    function item(classe, action) {
        const d = document.createElement('div');
        d.className = 'ss-item ' + classe; d.setAttribute('role', 'option'); d.id = 'ss-opt-' + items().length;
        d.addEventListener('click', action); boite.appendChild(d); return d;
    }
    function remplir(texte) { champ.value = texte; champ.dispatchEvent(new Event('input', { bubbles: true })); champ.focus(); }
    function afficher() {
        const brut = champ.value.trim();
        boite.innerHTML = ''; actif = -1; champ.removeAttribute('aria-activedescendant');
        if (!brut) {
            const rec = lireRecentes();
            if (!rec.length) return fermer();
            titre(en() ? 'Recent searches' : 'Recherches récentes');
            rec.forEach(t => {
                const it = item('ss-rec', () => remplir(t));
                const ico = document.createElement('span'); ico.className = 'ss-ico'; ico.textContent = '🕘';
                const txt = document.createElement('span'); txt.className = 'ss-main ss-nom'; txt.textContent = t;
                const x = document.createElement('button'); x.type = 'button'; x.className = 'ss-x'; x.textContent = '✕';
                x.setAttribute('aria-label', en() ? 'Remove' : 'Retirer');
                x.addEventListener('click', e => { e.stopPropagation(); ecrireRecentes(lireRecentes().filter(y => y !== t)); afficher(); });
                it.append(ico, txt, x);
            });
        } else if (normRecherche(brut).length >= 2 && allProducts.length) {
            const tous = suggestionsProduits(brut);
            if (tous.length) {
                tous.slice(0, 6).forEach(p => {
                    const it = item('ss-prod', () => { memoriserRecherche(brut); fermer(); champ.blur(); openModal(p.id); });
                    let img;
                    if (p.image_url) { img = document.createElement('img'); img.className = 'ss-img'; img.src = p.image_url; img.alt = ''; img.loading = 'lazy'; }
                    else { img = document.createElement('span'); img.className = 'ss-img ss-img-ph'; img.textContent = '📦'; }
                    const main = document.createElement('span'); main.className = 'ss-main';
                    const nom = document.createElement('span'); nom.className = 'ss-nom';
                    nom.appendChild(fragmentSurligne(texteProduit(p).name, brut));
                    const sous = document.createElement('span'); sous.className = 'ss-sous';
                    sous.appendChild(document.createTextNode(catLabel(p.category) + ' · '));
                    const prix = document.createElement('span');
                    if (p.quantity === 0) { prix.className = 'ss-indispo'; prix.textContent = en() ? 'Unavailable' : 'Indisponible'; }
                    else { prix.className = 'ss-prix'; prix.textContent = fmt(getPrix(p)) + ' FCFA'; }
                    sous.appendChild(prix);
                    main.append(nom, sous); it.append(img, main);
                });
                const pied = item('ss-pied', () => { memoriserRecherche(brut); fermer(); champ.blur(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
                pied.textContent = en() ? `See all ${tous.length} results` : `Voir les ${tous.length} résultats`;
            } else {
                const v = document.createElement('div'); v.className = 'ss-vide';
                v.textContent = (en() ? 'No product for ' : 'Aucun produit pour ') + '« ' + brut + ' »';
                boite.appendChild(v);
                const m = motProche(brut);
                if (m) {
                    const it = item('ss-dym', () => remplir(m));
                    const b = document.createElement('b'); b.textContent = m;
                    it.append(document.createTextNode((en() ? 'Did you mean: ' : 'Vouliez-vous dire : ')), b, document.createTextNode(' ?'));
                }
            }
        } else return fermer();
        boite.hidden = false; champ.setAttribute('aria-expanded', 'true');
    }
    champ.addEventListener('input', afficher);
    champ.addEventListener('focus', afficher);
    champ.addEventListener('keydown', e => {
        if (boite.hidden) { if (e.key === 'ArrowDown') afficher(); return; }
        const l = items();
        if (e.key === 'ArrowDown') { e.preventDefault(); choisir(l.length ? (actif + 1) % l.length : -1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); choisir(l.length ? (actif <= 0 ? l.length - 1 : actif - 1) : -1); }
        else if (e.key === 'Enter') {
            if (actif >= 0 && l[actif]) { e.preventDefault(); l[actif].click(); }
            else { memoriserRecherche(champ.value); fermer(); champ.blur(); }
        }
        else if (e.key === 'Escape') fermer();
    });
    boite.addEventListener('mousedown', e => e.preventDefault());   // garde le focus dans le champ
    document.addEventListener('click', e => { if (!boite.hidden && !e.target.closest('.header-search-full')) fermer(); });
}

// ===== RECHERCHE PAR PHOTO : panneau dédié =====
// Panneau qu'on peut quitter à tout moment (✕, Échap, clic à côté, Annuler). Étapes : choisir une image
// (appareil photo ou galerie) → analyse (image réduite, 25 s maximum) → articles trouvés ou message d'aide.
const phT = (fr, en) => currentLang === 'en' ? en : fr;
function normMot(m) { let n = normRecherche(m); if (n.length > 3 && /[sx]$/.test(n)) n = n.slice(0, -1); return n; }   // « écouteurs » → « ecouteur »

// Réduit la photo (800 px, JPEG) : de 3-8 Mo à ~100 Ko, donc envoi beaucoup plus rapide sur réseau mobile
async function preparerImagePhoto(fichier, max = 800, qualite = 0.75) {
    if (!fichier || !/^image\//.test(fichier.type || '')) throw new Error('format');
    if (fichier.size > 25 * 1024 * 1024) throw new Error('trop-grande');
    const url = URL.createObjectURL(fichier);
    try {
        const img = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error('format')); i.src = url; });
        const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = c.toDataURL('image/jpeg', qualite);
        return { dataUrl, base64: dataUrl.split(',')[1] };
    } finally { URL.revokeObjectURL(url); }
}

// Articles proposés : d'abord ceux que l'IA a choisis dans le catalogue, puis ceux qui partagent ses mots-clés
function classerParPhoto(result) {
    const parId = new Map(allProducts.map(p => [String(p.id), p]));
    const direct = [];
    (result.ids || []).forEach(i => { const p = parId.get(String(i)); if (p && !direct.includes(p)) direct.push(p); });
    const mots = [...new Set((result.motscles || []).map(normMot).filter(m => m.length >= 3))];
    const notes = [];
    allProducts.forEach(p => {
        if (direct.includes(p)) return;
        const nom = normRecherche(p.name), cat = normRecherche(p.category), desc = normRecherche(p.description);
        let score = 0;
        mots.forEach(m => { if (nom.includes(m)) score += 3; else if (cat.includes(m) || desc.includes(m)) score += 1; });
        if (score > 0) notes.push({ p, score });
    });
    notes.sort((a, b) => b.score - a.score);
    let liste = direct.length ? direct.concat(notes.filter(x => x.score >= 3).map(x => x.p)) : notes.map(x => x.p);
    liste = liste.slice(0, 8);
    let parCategorie = false;
    if (!liste.length && result.category && result.category !== 'Autre') {
        liste = allProducts.filter(p => p.category === result.category).slice(0, 8);
        parCategorie = liste.length > 0;
    }
    return { liste, parCategorie };
}
function appliquerResultatsPhoto(liste) {
    $('search-bar').value = '';
    _requeteRecherche = '';
    currentCat = 'tous';
    document.querySelectorAll('.cat-pill').forEach(b => b.classList.toggle('active', b.dataset.cat === 'tous'));
    majModeRecherche(true);
    renderProducts(liste);
    $('produits').scrollIntoView({ behavior: 'smooth' });
}

function ouvrirPanneauPhoto() {
    if (document.getElementById('photo-panel')) return;
    if (typeof fermerSuggestions === 'function') fermerSuggestions();
    const T = phT;
    const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    const bouton = (txt, cls, fn) => { const b = el('button', cls, txt); b.type = 'button'; b.addEventListener('click', fn); return b; };
    const ancienScroll = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const ov = el('div', 'photo-overlay'); ov.id = 'photo-panel';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'photo-titre');
    const feuille = el('div', 'photo-sheet');
    const tete = el('div', 'photo-head');
    const titre = el('h3', null, T('📷 Recherche par photo', '📷 Search by photo')); titre.id = 'photo-titre';
    const btnX = bouton('✕', 'photo-x', () => fermer()); btnX.setAttribute('aria-label', T('Fermer', 'Close'));
    tete.append(titre, btnX);
    const corps = el('div', 'photo-body');
    feuille.append(tete, corps); ov.append(feuille); document.body.append(ov);

    const etat = { ctrl: null, jeton: 0, apercu: '', base64: '', timers: [] };
    const raz = () => { etat.timers.forEach(clearTimeout); etat.timers = []; corps.replaceChildren(); };
    function fermer() {
        etat.jeton++; if (etat.ctrl) etat.ctrl.abort();
        etat.timers.forEach(clearTimeout);
        document.removeEventListener('keydown', surTouche); document.removeEventListener('paste', surColler);
        document.body.style.overflow = ancienScroll; ov.remove();
        const b = document.getElementById('btn-recherche-photo'); if (b) b.focus();
    }
    function surTouche(e) { if (e.key === 'Escape') fermer(); }
    function surColler(e) {
        const f = e.clipboardData && Array.from(e.clipboardData.files || []).find(x => /^image\//.test(x.type));
        if (f) { e.preventDefault(); lancer(f); }
    }
    document.addEventListener('keydown', surTouche); document.addEventListener('paste', surColler);
    ov.addEventListener('click', e => { if (e.target === ov) fermer(); });
    ov.addEventListener('dragover', e => e.preventDefault());
    ov.addEventListener('drop', e => {
        e.preventDefault();
        const f = Array.from((e.dataTransfer && e.dataTransfer.files) || []).find(x => /^image\//.test(x.type));
        if (f) lancer(f);
    });

    function choisir() {
        etat.jeton++; if (etat.ctrl) { etat.ctrl.abort(); etat.ctrl = null; }
        raz();
        corps.append(el('p', 'photo-intro', T("Montre-nous l'article que tu cherches : on te propose les produits qui lui ressemblent.", 'Show us the item you are looking for: we will suggest similar products.')));
        const camera = el('input'); camera.type = 'file'; camera.accept = 'image/*'; camera.setAttribute('capture', 'environment'); camera.hidden = true;
        const galerie = el('input'); galerie.type = 'file'; galerie.accept = 'image/*'; galerie.hidden = true;
        camera.onchange = galerie.onchange = e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) lancer(f); };
        const rang = el('div', 'photo-choix');
        rang.append(bouton(T('📷 Prendre une photo', '📷 Take a photo'), 'photo-btn photo-btn-main', () => camera.click()),
                    bouton(T('🖼️ Choisir une image', '🖼️ Choose an image'), 'photo-btn', () => galerie.click()));
        corps.append(rang, camera, galerie);
        corps.append(el('p', 'photo-astuce', T('💡 Un seul article, bien éclairé, sur fond uni : c’est plus précis.', '💡 One item, well lit, on a plain background: more accurate.')));
        if (window.matchMedia && matchMedia('(hover: hover)').matches) corps.append(el('p', 'photo-astuce', T('Tu peux aussi glisser-déposer ou coller (Ctrl+V) une image ici.', 'You can also drag & drop or paste (Ctrl+V) an image here.')));
    }
    function analyse(texte) {
        raz();
        if (etat.apercu) { const im = el('img', 'photo-apercu'); im.src = etat.apercu; im.alt = ''; corps.append(im); }
        corps.append(el('div', 'photo-spinner'));
        const p = el('p', 'photo-etat', texte); p.setAttribute('aria-live', 'polite'); corps.append(p);
        etat.timers.push(setTimeout(() => { p.textContent = T('Ça prend un peu plus de temps que d’habitude…', 'This is taking a bit longer than usual…'); }, 7000));
        corps.append(bouton(T('Annuler', 'Cancel'), 'photo-btn photo-btn-sec', choisir));
    }
    function erreur(msg, reessayer) {
        raz();
        corps.append(el('div', 'photo-ico', '⚠️'), el('p', 'photo-etat', msg));
        const rang = el('div', 'photo-choix');
        if (reessayer && etat.base64) rang.append(bouton(T('Réessayer', 'Try again'), 'photo-btn photo-btn-main', () => envoyer(++etat.jeton)));
        rang.append(bouton(T('Autre image', 'Another image'), 'photo-btn', choisir), bouton(T('Fermer', 'Close'), 'photo-btn photo-btn-sec', () => fermer()));
        corps.append(rang);
    }
    function resultats(result) {
        const { liste, parCategorie } = classerParPhoto(result);
        raz();
        const entete = el('div', 'photo-reco');
        if (etat.apercu) { const im = el('img', 'photo-miniature'); im.src = etat.apercu; im.alt = ''; entete.append(im); }
        const txt = el('div', 'photo-reco-txt');
        txt.append(el('div', 'photo-reco-titre', result.produit ? T('Reconnu : ', 'Recognised: ') + result.produit : T('Voici ce qu’on a trouvé', 'Here is what we found')));
        const chips = el('div', 'photo-chips');
        (result.motscles || []).slice(0, 4).forEach(m => chips.append(el('span', 'photo-chip', m)));
        txt.append(chips); entete.append(txt); corps.append(entete);
        if (liste.length) {
            corps.append(el('p', 'photo-note', parCategorie
                ? T('Pas d’article identique : voici d’autres produits de la catégorie ', 'No identical item: here are other products in the category ') + catLabel(result.category)
                : (en => en ? `${liste.length} similar product${liste.length > 1 ? 's' : ''}` : `${liste.length} produit${liste.length > 1 ? 's' : ''} ressemblant${liste.length > 1 ? 's' : ''}`)(currentLang === 'en')));
            const ul = el('div', 'photo-liste');
            liste.forEach(p => {
                const it = el('div', 'photo-item'); it.setAttribute('role', 'button'); it.tabIndex = 0;
                let im; if (p.image_url) { im = el('img', 'ss-img'); im.src = p.image_url; im.alt = ''; im.loading = 'lazy'; } else { im = el('span', 'ss-img ss-img-ph', '📦'); }
                const main = el('span', 'ss-main');
                main.append(el('span', 'ss-nom', texteProduit(p).name));
                const sous = el('span', 'ss-sous'); sous.append(document.createTextNode(catLabel(p.category) + ' · '));
                sous.append(p.quantity === 0 ? el('span', 'ss-indispo', T('Indisponible', 'Unavailable')) : el('span', 'ss-prix', fmt(getPrix(p)) + ' FCFA'));
                main.append(sous);
                const voir = el('span', 'photo-voir', T('Voir', 'View'));
                it.append(im, main, voir);
                const ouvrir = () => { fermer(); openModal(p.id); };
                it.addEventListener('click', ouvrir);
                it.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ouvrir(); } });
                ul.append(it);
            });
            corps.append(ul);
        } else {
            corps.append(el('p', 'photo-note', T('Aucun article du catalogue ne ressemble à cette photo pour le moment.', 'No catalogue item looks like this photo right now.')));
        }
        const rang = el('div', 'photo-choix');
        if (liste.length) rang.append(bouton(T('Voir tout dans la liste', 'See all in the list'), 'photo-btn photo-btn-main', () => { appliquerResultatsPhoto(liste); fermer(); }));
        rang.append(bouton(T('📷 Nouvelle photo', '📷 New photo'), 'photo-btn', choisir));
        if (!liste.length) {
            const wa = el('a', 'photo-btn photo-btn-main', T('💬 Demander sur WhatsApp', '💬 Ask on WhatsApp'));
            wa.href = 'https://wa.me/' + CONFIG.WA1 + '?text=' + encodeURIComponent(T('Bonjour Kapmaket, je cherche un article comme celui-ci : ', 'Hello Kapmaket, I am looking for an item like this: ') + (result.produit || ''));
            wa.target = '_blank'; wa.rel = 'noopener'; rang.append(wa);
        }
        corps.append(rang);
    }
    async function envoyer(jeton) {
        analyse(T('Analyse de ta photo…', 'Analysing your photo…'));
        const ctrl = new AbortController(); etat.ctrl = ctrl;
        const minuteur = setTimeout(() => ctrl.abort(), 25000);
        try {
            const resp = await fetch('/api/recherche-photo', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
                body: JSON.stringify({ image: etat.base64, media_type: 'image/jpeg', catalogue: allProducts.slice(0, 200).map(p => ({ id: p.id, n: p.name, c: p.category })) })
            });
            let result = null; try { result = await resp.json(); } catch (e) {}
            if (jeton !== etat.jeton) return;
            if (!resp.ok || !result) {
                const msg = resp.status === 413 ? T('Image trop lourde, essaie une autre photo.', 'Image too large, try another photo.')
                    : (result && result.error) || T('Recherche impossible pour le moment.', 'Search unavailable right now.');
                return erreur(msg, resp.status !== 429);
            }
            resultats(result);
        } catch (e) {
            if (jeton !== etat.jeton) return;   // annulée par le client
            erreur(T('La recherche prend trop de temps (réseau lent ?). Réessaie.', 'The search is taking too long (slow network?). Try again.'), true);
        } finally { clearTimeout(minuteur); if (etat.ctrl === ctrl) etat.ctrl = null; }
    }
    async function lancer(fichier) {
        const jeton = ++etat.jeton;
        if (etat.ctrl) { etat.ctrl.abort(); etat.ctrl = null; }
        etat.apercu = ''; analyse(T('Préparation de l’image…', 'Preparing the image…'));
        let img;
        try { img = await preparerImagePhoto(fichier); }
        catch (e) {
            if (jeton !== etat.jeton) return;
            return erreur(e.message === 'trop-grande' ? T('Cette image est trop lourde (25 Mo maximum).', 'This image is too large (25 MB maximum).') : T('Impossible de lire cette image. Essaie une photo JPG ou PNG.', 'Could not read this image. Try a JPG or PNG photo.'), false);
        }
        if (jeton !== etat.jeton) return;
        etat.apercu = img.dataUrl; etat.base64 = img.base64;
        envoyer(jeton);
    }
    choisir();
    btnX.focus();
}

// ===== RECHERCHE =====
function setupSearch() {
    setupAutocomplete();
    const norm = normRecherche;
    let _debounceRecherche = null;
    $('btn-fin-recherche').onclick = () => { finRecherche(true); renderProducts(allProducts); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    $('search-bar').oninput = e => {
        const brut = e.target.value.trim();
        const q = norm(brut);
        if (q) {
            // Entrée en mode recherche : on repart de « Tous » pour qu'aucun filtre de catégorie ne cache de résultat
            if (!document.body.classList.contains('mode-recherche')) {
                currentCat = 'tous';
                document.querySelectorAll('.cat-pill').forEach(b => b.classList.toggle('active', b.dataset.cat === 'tous'));
                window.scrollTo({ top: 0 });
            }
            _requeteRecherche = brut;
            majModeRecherche(true);
        } else {
            finRecherche(false);
        }
        renderProducts(allProducts);   // renderProducts applique lui-même le filtre de recherche
        clearTimeout(_debounceRecherche);
        if (e.target.value.trim().length >= 2) {
            _debounceRecherche = setTimeout(() => logVisiteur('recherche', e.target.value.trim()), 1200);
        }
    };

    // Recherche par photo : panneau dédié (appareil photo, galerie, glisser-déposer, résultats)
    $('btn-recherche-photo').onclick = ouvrirPanneauPhoto;
}

// ===== PRODUITS =====
async function fetchProducts() {
    try {
        const { data, error } = await db.from('products').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        allProducts = data || [];
        renderProducts(allProducts);
        appliquerPreferenceShopping();
        chargerFlash(allProducts);
        injecterSchemaCatalogue(allProducts);
        chargerFlashCombo();
        ouvrirProduitDepuisURL();
        const { data: slidesData } = await db.from('bannières').select('*').eq('type', 'slider').eq('actif', true);
        initSlider(slidesData);
    } catch(e) { console.error(e); renderProducts([]); initSlider([]); }
    finally { hide('loader'); }
}

// ===== SEO-IA : DONNÉES STRUCTUREES =====
function injecterJsonLd(id, data) {
    let el = document.getElementById(id);
    if (!el) {
        el = document.createElement('script');
        el.type = 'application/ld+json';
        el.id = id;
        document.head.appendChild(el);
    }
    el.textContent = JSON.stringify(data);
}

// Liste complète du catalogue, lisible par Google et les moteurs IA (AEO/GEO)
function injecterSchemaCatalogue(products) {
    if (!products.length) return;
    const items = products.slice(0, 50).map((p, i) => ({
        "@type": "ListItem",
        "position": i + 1,
        "item": {
            "@type": "Product",
            "name": p.name,
            "description": p.description || p.name,
            "category": p.category,
            "image": p.image_url || undefined,
            "offers": {
                "@type": "Offer",
                "priceCurrency": "XAF",
                "price": getPrix(p),
                "availability": p.quantity > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
                "url": "https://www.kapmaket.shop/produit/" + slugProduit(p)
            }
        }
    }));
    injecterJsonLd('schema-catalogue', {
        "@context": "https://schema.org",
        "@type": "ItemList",
        "name": "Catalogue Kapmaket",
        "itemListElement": items
    });
}

// Fiche produit détaillée injectée à l'ouverture de la modale produit
function injecterSchemaProduit(p) {
    injecterJsonLd('schema-produit', {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": p.name,
        "description": p.description || p.name,
        "category": p.category,
        "image": p.image_url || undefined,
        "sku": String(p.id),
        "offers": {
            "@type": "Offer",
            "priceCurrency": "XAF",
            "price": getPrix(p),
            "availability": p.quantity > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
            "url": "https://www.kapmaket.shop/produit/" + slugProduit(p),
            "seller": { "@type": "Organization", "name": "Kapmaket" }
        }
    });
}

// Bascule grille/liste, mémorisée pour les prochaines visites. On ne
// touche à rien d'autre : renderProducts() construit exactement le même
// HTML dans les deux cas, seule la classe CSS sur le conteneur change.
window.changerVueProduits = (mode) => {
    localStorage.setItem('cmkt_vue_produits', mode);
    $('product-grid').classList.toggle('vue-liste', mode === 'liste');
    $('btn-vue-grille').classList.toggle('active', mode === 'grille');
    $('btn-vue-liste').classList.toggle('active', mode === 'liste');
};
if (localStorage.getItem('cmkt_vue_produits') === 'liste') changerVueProduits('liste');

function renderProducts(products) {
    const grid = $('product-grid');
    if (_requeteRecherche) products = filtrerParRecherche(products, _requeteRecherche);
    const filtered = currentCat === 'tous' ? products : products.filter(p => p.category === currentCat);
    $('prod-count').textContent = filtered.length + (currentLang==='en' ? ' product(s)' : ' produit(s)');
    grid.innerHTML = '';
    if (!filtered.length && _requeteRecherche) {
        const en = currentLang === 'en';
        grid.innerHTML = `<div class="empty-state recherche-vide"><div class="recherche-vide-ico">🔍</div><strong>${en ? 'No product found for' : 'Aucun produit trouvé pour'} « ${echapperHtml(_requeteRecherche)} »</strong><p>${en ? 'Check the spelling, try another word, or send a photo of the item with 📷.' : "Vérifie l'orthographe, essaie un autre mot, ou envoie une photo de l'article avec 📷."}</p><button type="button" class="btn-voir-tout">${en ? 'See all products' : 'Voir tous les produits'}</button></div>`;
        grid.querySelector('.btn-voir-tout').onclick = () => { finRecherche(true); renderProducts(allProducts); };
        return;
    }
    if (!filtered.length) { grid.innerHTML = `<div class="empty-state">${currentLang==='en'?'No products available.':'Aucun produit disponible.'}</div>`; return; }
    filtered.forEach(p => {
        const card = document.createElement('div');
        card.className = 'card';
        const prix = getPrix(p);
        const hasPromo = (p.promo_active || p.flash_active) && p.promo_prix;
        const pct = hasPromo ? `-${Math.round((1-p.promo_prix/p.resale_price)*100)}%` : '';
        const txt = texteProduit(p);
        card.innerHTML = `
            <div class="card-img-wrap">
                ${p.image_url ? `<img src="${srcMini(p.image_url)}" data-orig="${p.image_url}" onerror="this.onerror=null;this.src=this.dataset.orig" alt="${txt.name}" class="card-img img-blurup" loading="lazy" onload="this.classList.add('loaded')">` : '<div class="card-img-ph">📦</div>'}
                ${p.quantity < 5 && p.quantity > 0 ? `<span class="badge badge-low">${currentLang==='en'?'Low stock':'Stock faible'}</span>` : ''}
                ${p.flash_active ? '<span class="badge badge-flash">⚡ FLASH</span>' : isNew(p.created_at) ? '<span class="badge badge-new">🆕</span>' : ''}
                ${p.promo_active && !p.flash_active ? '<span class="badge badge-promo">🔥 PROMO</span>' : ''}
                ${pct ? `<span class="badge badge-pct">${pct}</span>` : ''}
                <button class="btn-favori ${favorisIds.has(p.id)?'active':''}" data-id="${p.id}">${favorisIds.has(p.id)?'❤️':'🤍'}</button>
            </div>
            <div class="card-body">
                <div class="card-cat">${catLabel(p.category)}</div>
                <div class="card-name"><a class="card-lien" href="/produit/${slugProduit(p)}" onclick="if(!event.ctrlKey&&!event.metaKey&&!event.shiftKey)event.preventDefault()">${txt.name}</a></div>
                <div class="card-qty">${currentLang==='en'?'Qty':'Qté'} : ${p.quantity}</div>
                ${hasPromo ? `<div class="prix-barre-sm">${fmt(p.resale_price)} FCFA</div>` : ''}
                <div class="card-price ${hasPromo?'promo':''}">${fmt(prix)} FCFA</div>
                <button class="btn-acheter">${currentLang==='en'?'View details':'Voir détails'}</button>
            </div>`;
        card.querySelector('.btn-acheter').onclick = e => { e.stopPropagation(); openModal(p.id); };
        card.querySelector('.btn-favori').onclick = e => { e.stopPropagation(); toggleFavori(p.id, e.currentTarget); };
        card.onclick = () => openModal(p.id);
        card.dataset.trackId = p.id;
        card.dataset.trackNom = txt.name;
        _observateurImpressions.observe(card);
        grid.appendChild(card);
    });
}

// ===== FLASH =====
let flashInterval = null;
function filtrerFlash() {
    finRecherche(true);
    renderProducts(allProducts.filter(p => p.flash_active));
    $('produits').scrollIntoView({behavior:'smooth'});
}

function chargerFlash(prods) {
    const flash = prods.filter(p => p.flash_active && p.flash_fin && new Date(p.flash_fin) > new Date());
    const sec = $('flash-section');
    if (!flash.length) { sec.style.display = 'none'; return; }
    sec.style.display = 'block';
    const grid = $('flash-grid');
    grid.innerHTML = '';
    flash.forEach(p => {
        const card = document.createElement('div');
        card.className = 'card';
        const prix = getPrix(p);
        card.innerHTML = `<div class="card-img-wrap">
            ${p.image_url ? `<img src="${srcMini(p.image_url)}" data-orig="${p.image_url}" onerror="this.onerror=null;this.src=this.dataset.orig" alt="${texteProduit(p).name}" class="card-img img-blurup" loading="lazy" onload="this.classList.add('loaded')">` : '<div class="card-img-ph">📦</div>'}
            <span class="badge badge-flash">⚡ FLASH</span>
        </div>
        <div class="card-body">
            <div class="card-name">${texteProduit(p).name}</div>
            <div class="prix-barre-sm">${fmt(p.resale_price)} FCFA</div>
            <div class="card-price promo">${fmt(prix)} FCFA</div>
            <button class="btn-acheter">${currentLang==='en'?'Add to cart':'Ajouter au panier'}</button>
        </div>`;
        card.querySelector('.btn-acheter').onclick = () => openModal(p.id);
        grid.appendChild(card);
    });
    if (flashInterval) clearInterval(flashInterval);
    const timer = $('flash-timer');
    const tick = () => {
        const fin = flash.reduce((m,p)=>{ const d=new Date(p.flash_fin); return d<m?d:m; }, new Date(flash[0].flash_fin));
        const diff = fin - new Date();
        if (diff <= 0) { clearInterval(flashInterval); sec.style.display='none'; return; }
        const h=Math.floor(diff/3600000), m=Math.floor((diff%3600000)/60000), s=Math.floor((diff%60000)/1000);
        timer.textContent = `⏱ ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    };
    tick(); flashInterval = setInterval(tick, 1000);
}

async function afficherMeilleuresVentes() {
    finRecherche(true);
    const counts = {};
    try {
        // Le classement est calculé côté serveur : le navigateur ne lit plus aucune commande.
        const resp = await fetch('/api/preparer-paiement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meilleures_ventes: true }) });
        const j = await resp.json();
        if (!resp.ok || !j || !Array.isArray(j.ventes)) throw new Error('classement indisponible');
        j.ventes.forEach(v => { counts[v.nom] = v.quantite; });
    } catch (e) {
        // Repli temporaire sur l'ancienne vue de la base ; sans effet une fois la vue supprimée (voir sql/supprimer-vue-meilleures-ventes.sql).
        try {
            const { data } = await db.from('meilleures_ventes').select('items');
            (data||[]).forEach(r => (r.items||[]).forEach(i => { counts[i.name]=(counts[i.name]||0)+i.qty; }));
        } catch (e2) {}
    }
    const sorted = [...allProducts].sort((a,b) => (counts[b.name]||0)-(counts[a.name]||0));
    renderProducts(sorted);
    $('produits').scrollIntoView({behavior:'smooth'});
}

// ===== MODAL PRODUIT =====
async function openModal(productId) {
    const p = allProducts.find(x => x.id === productId);
    if (!p) return;
    modalProduct = p;
    logVisiteur('produit_vu', p.id, { nom: p.name, prix: getPrix(p) });
    $('qty-val').textContent = '1';
    const txt = texteProduit(p);
    $('prod-name').textContent = txt.name;
    $('prod-desc').textContent = txt.description || '';
    $('prod-cat-tag').textContent = catLabel(p.category);
    $('prod-new-tag').style.display = isNew(p.created_at) ? 'inline-block' : 'none';
    $('prod-low-tag').style.display = p.quantity < 5 ? 'inline-block' : 'none';
    const bf = $('btn-favori-prod');
    bf.textContent = favorisIds.has(p.id) ? '❤️ Dans mes favoris' : '🤍 Ajouter aux favoris';
    bf.classList.toggle('active', favorisIds.has(p.id));
    bf.onclick = () => { toggleFavori(p.id); bf.textContent = favorisIds.has(p.id) ? '❤️ Dans mes favoris' : '🤍 Ajouter aux favoris'; bf.classList.toggle('active', favorisIds.has(p.id)); };
    $('prod-flash-tag').style.display = p.flash_active ? 'block' : 'none';
    $('prod-stock').textContent = `Quantité disponible : ${p.quantity}`;
    const prix = getPrix(p);
    $('prod-price').textContent = fmt(prix) + ' FCFA';
    if ((p.promo_active || p.flash_active) && p.promo_prix) {
        $('prod-prix-barre').textContent = fmt(p.resale_price) + ' FCFA';
        $('prod-prix-barre').style.display = 'block';
    } else { $('prod-prix-barre').style.display = 'none'; }
    const img = $('prod-img');
    if (p.image_url) {
        img.style.opacity = '0';
        img.onload = () => { img.style.opacity = '1'; };
        img.src = p.image_url; img.style.display = 'block';
    } else img.style.display = 'none';
    const waMsg = encodeURIComponent(`Bonjour Kapmaket, intéressé par : ${p.name} (${fmt(prix)} FCFA)`);
    $('prod-wa').href = `https://wa.me/${CONFIG.WA1}?text=${waMsg}`;
    // "Ajouter au panier" est maintenant disponible à tout le monde — la
    // connexion n'est demandée qu'au moment de payer (achat invité possible).
    $('prod-actions').style.display='flex';
    $('prod-login-hint').style.display='none';
    $('feedback-produit-zone').innerHTML = htmlFeedbackProduit(p.id, p.category);
    openOverlay('prod-overlay');
    const urlProduit = '/produit/' + slugProduit(p);
    if (window.location.pathname !== urlProduit) window.history.replaceState(null, '', urlProduit);
    chargerCrossSell(p);
    chargerAvis(p.id);
    injecterSchemaProduit(p);
}

$('prod-close').onclick = () => closeOverlay('prod-overlay');
$('prod-overlay').onclick = e => { if(e.target===$('prod-overlay')) closeOverlay('prod-overlay'); };
$('qty-minus').onclick = () => { const v=parseInt($('qty-val').textContent); if(v>1) $('qty-val').textContent=v-1; };
$('qty-plus').onclick = () => { const v=parseInt($('qty-val').textContent); if(v<modalProduct.quantity) $('qty-val').textContent=v+1; };
$('btn-add-cart').onclick = () => {
    const qty = parseInt($('qty-val').textContent);
    const prix = getPrix(modalProduct);
    const ex = panier.find(x => x.id === modalProduct.id);
    if (ex) ex.qty = Math.min(ex.qty+qty, modalProduct.quantity);
    else panier.push({ id:modalProduct.id, name:modalProduct.name, prix, prix_reel:prixReelProduit(modalProduct), qty, image_url:modalProduct.image_url });
    logVisiteur('panier_ajout', modalProduct.id, { nom: modalProduct.name, qty, prix });
    updatePanierBtn();
    syncPanierServeur();
    const imgEl = document.querySelector('#prod-overlay .prod-img, #prod-overlay img');
    volerVersPanier(modalProduct.image_url, imgEl); // capture la position avant fermeture
    closeOverlay('prod-overlay');
};

// ===== CROSS-SELLING =====
async function chargerCrossSell(p) {
    const zone = $('cross-sell-zone');
    zone.innerHTML = '';
    const { data } = await db.from('products').select('*').eq('category', p.category).neq('id', p.id).limit(4);
    if (!data?.length) return;
    zone.innerHTML = `<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
        <h4 style="font-size:0.88rem;color:var(--text2);margin-bottom:10px">💡 Souvent achetés ensemble</h4>
        <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;scrollbar-width:none">
            ${data.map(cs=>`<div onclick="closeOverlay('prod-overlay');setTimeout(()=>openModal('${cs.id}'),100)" style="min-width:110px;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px;cursor:pointer;text-align:center;flex-shrink:0">
                ${cs.image_url?`<img src="${cs.image_url}" alt="${cs.name}" class="img-blurup" loading="lazy" onload="this.classList.add('loaded')" style="width:100%;height:55px;object-fit:cover;border-radius:6px;margin-bottom:6px">`:'<div style="height:55px;display:flex;align-items:center;justify-content:center;font-size:1.5rem">📦</div>'}
                <div style="font-size:0.72rem;font-weight:600;line-height:1.2;margin-bottom:4px">${cs.name}</div>
                <div style="font-size:0.8rem;color:var(--orange-text);font-weight:700">${fmt(getPrix(cs))} F</div>
                <button onclick="event.stopPropagation();addQuick('${cs.id}',event)" style="width:100%;background:var(--orange);color:white;border:none;padding:4px;border-radius:var(--radius-pill);font-size:0.7rem;font-weight:700;cursor:pointer;margin-top:4px">+ Ajouter</button>
            </div>`).join('')}
        </div>
    </div>`;
}

window.addQuick = (id, evt) => {
    const p = allProducts.find(x=>x.id===id);
    if (!p) return;
    const ex = panier.find(x=>x.id===id);
    if (ex) ex.qty++;
    else panier.push({id:p.id, name:p.name, prix:getPrix(p), prix_reel:prixReelProduit(p), qty:1});
    logVisiteur('panier_ajout', p.id, { nom: p.name, qty: ex ? ex.qty : 1, prix: getPrix(p) });
    updatePanierBtn();
    syncPanierServeur();
    const fromEl = evt?.currentTarget?.closest('div')?.querySelector('img') || evt?.currentTarget;
    volerVersPanier(p.image_url, fromEl);
};

// ===== AVIS =====
async function chargerAvis(productId) {
    const zone = $('avis-zone');
    const { data } = await db.from('avis').select('*').eq('product_id', productId).eq('valide', true).order('created_at', {ascending:false});
    const moy = data?.length ? (data.reduce((s,a)=>s+a.note,0)/data.length).toFixed(1) : 0;
    const stars = n => '★'.repeat(Math.round(n))+'☆'.repeat(5-Math.round(n));
    zone.innerHTML = `<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
        <h3 style="font-size:1rem;font-weight:700;margin-bottom:12px">⭐ Avis clients</h3>
        ${data?.length?`<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <span style="font-size:2rem;font-weight:800;color:var(--orange-text);font-family:Poppins,sans-serif">${moy}</span>
            <div><div style="color:#f4c430;font-size:1.1rem">${stars(moy)}</div><div style="color:var(--text3);font-size:0.82rem">${data.length} avis</div></div>
        </div>`:''}
        ${currentUser?`<button onclick="toggleFormAvis('${productId}')" style="background:var(--bg);color:var(--text);border:1.5px solid var(--border);padding:8px 16px;border-radius:8px;cursor:pointer;font-size:0.85rem;margin-bottom:12px">✏️ Laisser un avis</button>`:''}
        <div id="form-avis-${productId}" style="display:none;background:var(--bg);border-radius:10px;padding:14px;margin-bottom:14px;border:1px solid var(--border)">
            <h4 style="margin-bottom:10px;font-size:0.95rem">Votre avis</h4>
            <div id="stars-${productId}" style="display:flex;gap:4px;margin-bottom:10px">
                ${[1,2,3,4,5].map(i=>`<button onclick="setNote(${i},'${productId}')" onmouseenter="previewNote(${i},'${productId}')" onmouseleave="previewNote(selectedNote,'${productId}')" style="font-size:1.6rem;cursor:pointer;color:var(--border);background:none;border:none;padding:2px;transition:color 0.15s var(--ease),transform 0.15s var(--ease)" class="star-btn-${productId}">★</button>`).join('')}
            </div>
            <textarea id="avis-txt-${productId}" placeholder="Votre commentaire..." rows="3" style="width:100%;background:var(--card);border:1.5px solid var(--border);padding:10px;color:var(--text);border-radius:8px;font-size:0.88rem;resize:vertical;font-family:Inter,sans-serif;margin-bottom:10px"></textarea>
            <label style="display:inline-block;background:var(--card);color:var(--text);padding:7px 14px;border-radius:7px;cursor:pointer;border:1px solid var(--border);font-size:0.82rem;margin-bottom:10px">
                📷 Ajouter une photo<input type="file" id="avis-file-${productId}" accept="image/*" style="display:none" onchange="previewAvis(this,'${productId}')">
            </label>
            <img id="avis-preview-${productId}" src="" style="display:none;width:60px;height:60px;object-fit:cover;border-radius:6px;margin-left:8px;vertical-align:middle">
            <button onclick="soumettreAvis('${productId}')" style="width:100%;background:var(--green);color:white;border:none;padding:11px;border-radius:8px;font-weight:700;cursor:pointer;margin-top:6px">Publier</button>
            <p id="avis-msg-${productId}" style="min-height:18px;font-size:0.82rem;margin-top:6px"></p>
        </div>
        ${data?.length?data.map(a=>`<div style="background:var(--bg);border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
                <strong style="font-size:0.88rem">${echapperHtml(a.nom_client)}</strong>
                <span style="color:var(--text3);font-size:0.75rem">${new Date(a.created_at).toLocaleDateString('fr-FR')}</span>
            </div>
            <div style="color:#f4c430;font-size:0.9rem">${stars(a.note)}</div>
            ${a.commentaire?`<p style="color:var(--text2);font-size:0.85rem;margin-top:6px">${echapperHtml(a.commentaire)}</p>`:''}
            ${a.photo_url?`<img src="${a.photo_url}" alt="Photo jointe par ${echapperHtml(a.nom_client)}" style="width:75px;height:75px;object-fit:cover;border-radius:7px;margin-top:8px;cursor:pointer" onclick="window.open('${a.photo_url}','_blank')">`:''}
        </div>`).join(''):'<p style="color:var(--text3);font-size:0.85rem">Aucun avis pour le moment.</p>'}
    </div>`;
}

window.toggleFormAvis = id => { const el=$(`form-avis-${id}`); if(el) el.style.display=el.style.display==='none'?'block':'none'; };
window.setNote = (n, id) => {
    selectedNote = n;
    previewNote(n, id);
};
window.previewNote = (n, id) => {
    document.querySelectorAll(`.star-btn-${id}`).forEach((btn,i) => {
        btn.style.color = i<n ? '#f4c430' : 'var(--border)';
        btn.style.transform = i<n ? 'scale(1.12)' : 'scale(1)';
    });
};
window.previewAvis = (input, id) => {
    avisFile = input.files[0]; if(!avisFile)return;
    const reader = new FileReader();
    reader.onload = e => { const img=$(`avis-preview-${id}`); img.src=e.target.result; img.style.display='inline-block'; };
    reader.readAsDataURL(avisFile);
};
window.soumettreAvis = async pid => {
    const msg = $(`avis-msg-${pid}`);
    if (!selectedNote) { msg.style.color='var(--danger)'; msg.textContent='❌ Choisissez une note'; return; }
    let photoUrl = null;
    if (avisFile) { try { photoUrl = await uploadImage(avisFile); } catch(e){} }
    const { error } = await db.from('avis').insert([{
        product_id:pid, utilisateur_id:currentUser.id, nom_client:currentUser.nom,
        note:selectedNote, commentaire:$(`avis-txt-${pid}`).value.trim()||null, photo_url:photoUrl, valide:false
    }]);
    if (error) { msg.style.color='var(--danger)'; msg.textContent='❌ '+error.message; return; }
    msg.style.color='var(--success)'; msg.textContent='✅ Avis soumis ! En attente de validation.';
    selectedNote=0; avisFile=null;
};

// ===== PANIER =====
// Envoie une petite pastille (photo du produit) depuis le point de clic
// jusqu'à l'icône panier, avec rebond à l'arrivée — retour visuel clair
// que l'ajout a bien eu lieu, sans bloquer l'interaction.
function volerVersPanier(imageUrl, fromEl) {
    const cible = $('panier-btn');
    if (!cible || cible.style.display === 'none' && !cible.offsetParent) { /* le badge apparaîtra quand même via updatePanierBtn */ }
    const cibleRect = cible.getBoundingClientRect();
    const departRect = fromEl ? fromEl.getBoundingClientRect() : cibleRect;
    const taille = 46;

    const ghost = document.createElement('div');
    ghost.className = 'fly-to-cart-ghost';
    ghost.style.width = taille + 'px';
    ghost.style.height = taille + 'px';
    ghost.style.left = (departRect.left + departRect.width/2 - taille/2) + 'px';
    ghost.style.top = (departRect.top + departRect.height/2 - taille/2) + 'px';
    if (imageUrl) ghost.style.backgroundImage = `url('${imageUrl}')`;
    else ghost.style.background = 'var(--orange)';

    const dx = (cibleRect.left + cibleRect.width/2) - (departRect.left + departRect.width/2);
    const dy = (cibleRect.top + cibleRect.height/2) - (departRect.top + departRect.height/2);
    ghost.style.setProperty('--fly-end', `translate(${dx}px, ${dy}px)`);

    document.body.appendChild(ghost);
    ghost.addEventListener('animationend', () => {
        ghost.remove();
        cible.classList.add('bump');
        const badge = $('panier-count');
        if (badge) { badge.classList.add('pop'); setTimeout(() => badge.classList.remove('pop'), 500); }
        setTimeout(() => cible.classList.remove('bump'), 500);
    });
}

// ===== RÉTROACTION FICHE PRODUIT (personnalisation légère) =====
const FEEDBACK_OPTIONS = [
    { id: 'plus', label: '👍 Je veux en voir plus', effet: 'On te montre plus de ce style' },
    { id: 'moins', label: '👎 Je ne veux plus voir ça', effet: 'On réduira ce type de produit' },
    { id: 'cher', label: '💸 Trop cher pour moi', effet: 'Priorité aux meilleurs prix' },
    { id: 'possede', label: '✅ Déjà acheté, discutons-en', effet: 'On t\'ouvre WhatsApp' }
];

function htmlFeedbackProduit(produitId, categorie) {
    return `<div class="feedback-produit-inline">
        <p class="feedback-produit-question">Cette offre vous convient ?</p>
        <div class="feedback-produit-choix">
            ${FEEDBACK_OPTIONS.map(o => `<button onclick="choisirFeedbackProduit('${o.id}','${produitId}','${(categorie||'').replace(/'/g,"\\'")}')">${o.label}</button>`).join('')}
        </div>
        <p style="font-size:0.68rem;color:var(--text3);margin-top:6px">Ton choix nous aide à t'afficher des produits qui te correspondent mieux.</p>
    </div>`;
}

window.choisirFeedbackProduit = (choixId, produitId, categorie) => {
    const option = FEEDBACK_OPTIONS.find(o => o.id === choixId);
    const p = allProducts.find(x => x.id === produitId);

    if (choixId === 'possede') {
        // Ouvre directement la discussion WhatsApp, comme demandé.
        const texte = encodeURIComponent(`Bonjour, j'ai déjà acheté "${p?.name||'ce produit'}" chez vous, je voudrais en discuter.`);
        window.open(`https://wa.me/${CONFIG.WA1}?text=${texte}`, '_blank');
    }

    // Envoi au serveur pour consultation admin (best-effort, ne bloque jamais l'UI).
    db.from('feedback_produits').insert([{
        produit_id: produitId || null, produit_nom: p?.name || null, categorie: categorie || null,
        choix: choixId, utilisateur_id: currentUser?.id || null
    }]).then(({error}) => { if (error) console.error('Erreur envoi feedback:', error); });

    // Préférence gardée aussi localement, pour affiner la grille produits
    // de cette visite sans attendre de round-trip serveur.
    let categoriesMoins = JSON.parse(localStorage.getItem('cmkt_pref_categories_moins') || '[]');
    let categoriesPlus = JSON.parse(localStorage.getItem('cmkt_pref_categories_plus') || '[]');
    if (choixId === 'moins' && categorie) { categoriesMoins = [...new Set([...categoriesMoins, categorie])]; localStorage.setItem('cmkt_pref_categories_moins', JSON.stringify(categoriesMoins)); }
    if (choixId === 'plus' && categorie) { categoriesPlus = [...new Set([...categoriesPlus, categorie])]; localStorage.setItem('cmkt_pref_categories_plus', JSON.stringify(categoriesPlus)); }
    localStorage.setItem('cmkt_pref_shopping', JSON.stringify({ choix: choixId, categorie, le: Date.now() }));

    const zone = $('feedback-produit-zone');
    if (zone) zone.innerHTML = `<div class="feedback-produit-merci">Merci ! 🙌 ${option?.effet || 'Préférence enregistrée'}</div>`;
    setTimeout(appliquerPreferenceShopping, 300);
};

// Applique les préférences enregistrées à la grille : tri par prix
// croissant si "trop cher" a été choisi, et un léger réordonnancement qui
// met en avant les catégories aimées / recule celles boudées. Reste
// discret — n'écrase jamais un filtre de catégorie choisi manuellement.
function appliquerPreferenceShopping() {
    const brut = localStorage.getItem('cmkt_pref_shopping');
    if (!brut || !allProducts.length) return;
    try {
        const pref = JSON.parse(brut);
        const categoriesMoins = JSON.parse(localStorage.getItem('cmkt_pref_categories_moins') || '[]');
        const categoriesPlus = JSON.parse(localStorage.getItem('cmkt_pref_categories_plus') || '[]');
        let liste = [...allProducts];
        if (categoriesPlus.length || categoriesMoins.length) {
            const poids = p => (categoriesPlus.includes(p.category) ? -1 : 0) + (categoriesMoins.includes(p.category) ? 1 : 0);
            liste.sort((a, b) => poids(a) - poids(b));
        }
        if (pref.choix === 'cher') liste.sort((a, b) => getPrix(a) - getPrix(b));
        renderProducts(liste);
    } catch (e) { /* préférence ignorée si corrompue */ }
}

function updatePanierBtn() {
    const total = panier.reduce((s,p)=>s+p.qty,0);
    $('panier-count').textContent = total;
    $('panier-btn').style.display = total > 0 ? '' : 'none';
}

// ===== SYNCHRO PANIER ENTRE APPAREILS =====
// Objectif : un client qui commence sa commande sur PC et revient sur son téléphone
// pour payer doit retrouver son panier déjà là, à jour.
let syncPanierTimeout = null;     // sauvegarde locale en attente (anti-rebond)
let syncPanierEnCours = false;    // sauvegarde en cours d'envoi au serveur
let derniereMajPanier = null;     // date de la dernière version du panier connue du serveur
let panierPollTimer = null;       // interrogation de secours pour la synchro multi-appareils
let panierCanal = null;           // canal Supabase Realtime (simple signal « le panier a changé »)
let panierCanalPret = false;      // vrai quand le canal instantané fonctionne
let panierInviteAFusionner = null; // panier d'invité à reprendre UNE fois dans le compte
const INTERVALLE_SYNC_PANIER_RAPIDE = 15000; // sans canal instantané : vérification toutes les 15 s
const INTERVALLE_SYNC_PANIER_LENT = 60000;   // avec canal instantané : simple filet de sécurité

// Sauvegarde le panier courant côté serveur (anti-rebond : regroupe les appels rapprochés
// pour ne pas spammer Supabase à chaque clic +/-).
function syncPanierServeur() {
    // Sauvegarde locale immédiate, pour tout le monde (connecté ou invité) —
    // survit à un rechargement de page ou une fermeture d'onglet, même sans
    // compte. Un compte connecté bénéficie EN PLUS de la synchro serveur
    // multi-appareils ci-dessous (source de vérité dans ce cas).
    try {
        localStorage.setItem('cmkt_panier_invite', JSON.stringify({
            items: panier, zone: userZone || null, frais: fraisLivraison || 0, horodatage: Date.now(),
            // À qui appartient cette copie : id du compte, ou null pour un visiteur sans compte.
            proprietaire: currentUser ? currentUser.id : null
        }));
    } catch (e) {}

    if (!currentUser) return;
    clearTimeout(syncPanierTimeout);
    syncPanierTimeout = setTimeout(async () => {
        syncPanierTimeout = null;
        syncPanierEnCours = true;
        try {
            // Le panier passe par le serveur (jeton Firebase vérifié) : la table
            // `paniers` n'est plus accessible avec la clé publique.
            const j = await appelCompte('POST', null, {
                action: 'panier_sauver', items: panier,
                zone: userZone || null, frais_livraison: fraisLivraison || 0
            });
            if (j.updated_at) derniereMajPanier = j.updated_at; // c'est notre propre sauvegarde
            signalerMajPanier();                                // les autres appareils se mettent à jour tout de suite
        } catch (e) { console.error('Erreur synchro panier :', e.message || e); }
        syncPanierEnCours = false;
    }, 300);
}

// Charge le panier sauvegardé côté serveur à la connexion (ou à la restauration de session).
// Fusionne avec un panier local déjà présent au lieu de l'écraser, pour ne jamais faire
// perdre un article que le client vient d'ajouter avant même que la fusion arrive.
// Pour un compte connecté, le SERVEUR fait foi : on remplace le panier local par celui
// du serveur. (Avant, on fusionnait avec la copie gardée dans le navigateur : un article
// acheté ou retiré sur un appareil revenait depuis la vieille copie de l'autre appareil,
// et le nombre d'articles montait ou descendait au rechargement.)
// Seule exception : le panier rempli SANS compte juste avant de se connecter, repris
// une seule fois dans le compte.
async function chargerPanierServeur(fusionnerPanierInvite = false) {
    if (!currentUser) return;
    const aFusionner = panierInviteAFusionner
        || (fusionnerPanierInvite && panier.length ? panier.map(x => ({ ...x })) : null);
    panierInviteAFusionner = null;
    try {
        const j = await appelCompte('GET', 'panier');
        // Le client vient de modifier son panier : sa version part au serveur et prime.
        if (syncPanierTimeout || syncPanierEnCours) return;
        const data = j.panier;
        let aEnregistrer = false;
        if (data) {
            derniereMajPanier = data.updated_at || null;
            panier = (data.items || []).map(x => ({ ...x }));
            if (data.zone) userZone = data.zone;
            if (aFusionner) {
                aFusionner.forEach(item => {
                    const ex = panier.find(x => x.id === item.id && (x.combo_id || null) === (item.combo_id || null));
                    if (ex) ex.qty = Math.max(ex.qty, item.qty); else panier.push(item);
                });
                aEnregistrer = true;
            }
        } else {
            // Pas encore de panier serveur : on garde ce qu'il y a (copie locale ou panier d'invité).
            if (aFusionner) panier = aFusionner;
            aEnregistrer = panier.length > 0;
        }
        updatePanierBtn();
        if ($('zone-select') && userZone) { $('zone-select').value = userZone; updateLivraison(true); }
        if ($('panier-overlay') && $('panier-overlay').style.display === 'flex') renderPanier();
        if (aEnregistrer) syncPanierServeur();
    } catch (e) { /* hors ligne : on garde la copie locale affichée */ }
}

// Restaure le panier d'un visiteur SANS compte depuis le navigateur — c'est
// la seule "mémoire" possible pour lui, vu qu'il n'y a pas de compte pour
// synchroniser côté serveur. Expire au bout de 14 jours pour ne pas proposer
// un panier avec des prix ou un stock trop anciens.
function restaurerPanierInvite() {
    try {
        const brut = localStorage.getItem('cmkt_panier_invite');
        if (!brut) return;
        const sauvegarde = JSON.parse(brut);
        if (!sauvegarde || !Array.isArray(sauvegarde.items) || !sauvegarde.items.length) return;
        if (sauvegarde.horodatage && (Date.now() - sauvegarde.horodatage) > 14 * 24 * 3600 * 1000) {
            localStorage.removeItem('cmkt_panier_invite');
            return;
        }
        // proprietaire : id du compte, null (visiteur sans compte) ou absent (ancien format).
        const proprio = ('proprietaire' in sauvegarde) ? sauvegarde.proprietaire : undefined;
        if (currentUser) {
            // Panier d'un autre compte sur ce navigateur : on l'ignore.
            if (proprio && proprio !== currentUser.id) return;
            // Panier d'un visiteur sans compte : repris UNE fois dans le compte (voir chargerPanierServeur).
            if (proprio === null) { panierInviteAFusionner = sauvegarde.items; return; }
            // Sinon : simple copie du panier du compte, affichée en attendant la réponse du
            // serveur (qui fera foi).
        } else if (proprio) {
            return; // jamais le panier d'un compte pour un visiteur déconnecté
        }
        panier = sauvegarde.items;
        if (sauvegarde.zone) userZone = sauvegarde.zone;
        if (sauvegarde.frais) fraisLivraison = sauvegarde.frais;
        updatePanierBtn();
        if ($('zone-select') && userZone) { $('zone-select').value = userZone; updateLivraison(true); }
    } catch (e) {}
}

// Synchro avec un AUTRE appareil connecté au même compte (ex : le client ajoute un
// article sur PC pendant que son téléphone est ouvert sur le site). Le panier
// n'étant plus lisible avec la clé publique, la mise à jour passe par le serveur :
// un signal instantané (canal Realtime, sans donnée) prévient les autres appareils,
// avec en filet de sécurité une vérification régulière (onglet visible seulement) et
// dès que l'onglet redevient visible.
async function verifierPanierDistant() {
    if (!currentUser || document.hidden) return;
    if (syncPanierTimeout || syncPanierEnCours) return; // des modifs locales sont en route
    try {
        const j = await appelCompte('GET', 'panier');
        const data = j.panier;
        if (!data || !data.updated_at || data.updated_at === derniereMajPanier) return;
        if (syncPanierTimeout || syncPanierEnCours) return; // une modif locale a démarré pendant l'appel
        derniereMajPanier = data.updated_at;
        panier = data.items || [];
        userZone = data.zone || userZone;
        fraisLivraison = data.frais_livraison || 0;
        updatePanierBtn();
        if ($('zone-select')) $('zone-select').value = userZone || '';
        if ($('panier-overlay') && $('panier-overlay').style.display === 'flex') {
            panier.length ? renderPanier() : openPanier();
        }
    } catch (e) { /* réseau coupé ou session expirée : on réessaiera au prochain tour */ }
}
function surVisibilitePanier() { if (!document.hidden) verifierPanierDistant(); }

// Programme la vérification de secours : 15 s tant que le signal instantané n'est
// pas disponible, 60 s quand il fonctionne.
function programmerVerifPanier() {
    if (panierPollTimer) clearInterval(panierPollTimer);
    panierPollTimer = setInterval(verifierPanierDistant, panierCanalPret ? INTERVALLE_SYNC_PANIER_LENT : INTERVALLE_SYNC_PANIER_RAPIDE);
}

// Canal « signal seulement » (Supabase Realtime Broadcast) : quand un appareil
// enregistre son panier, il envoie un simple « maj » (AUCUNE donnée de panier dans le
// message) ; les autres appareils du même compte vont alors lire le panier via le
// serveur authentifié. Le contenu du panier ne transite jamais par ce canal.
function ouvrirCanalPanier() {
    if (!currentUser || panierCanal || typeof db.channel !== 'function') return;
    try {
        panierCanal = db.channel('panier-' + currentUser.id, { config: { broadcast: { self: false } } });
        panierCanal.on('broadcast', { event: 'maj' }, () => verifierPanierDistant());
        panierCanal.subscribe((statut) => {
            const pret = (statut === 'SUBSCRIBED');
            if (pret !== panierCanalPret) { panierCanalPret = pret; if (panierPollTimer) programmerVerifPanier(); }
        });
    } catch (e) { panierCanal = null; panierCanalPret = false; }
}

function signalerMajPanier() {
    if (!panierCanal || !panierCanalPret) return;
    try {
        const envoi = panierCanal.send({ type: 'broadcast', event: 'maj', payload: { t: Date.now() } });
        if (envoi && envoi.catch) envoi.catch(() => {});
    } catch (e) {}
}

function ecouterPanierEnDirect() {
    if (!currentUser || panierPollTimer) return;
    programmerVerifPanier();
    document.addEventListener('visibilitychange', surVisibilitePanier);
    ouvrirCanalPanier();
}

// Coupe la synchro (à la déconnexion).
function arreterEcoutePanier() {
    if (panierPollTimer) { clearInterval(panierPollTimer); panierPollTimer = null; }
    document.removeEventListener('visibilitychange', surVisibilitePanier);
    if (panierCanal) { try { db.removeChannel(panierCanal); } catch (e) {} panierCanal = null; }
    panierCanalPret = false;
}

function setupPanier() {
    $('panier-btn').onclick = openPanier;
    $('panier-close').onclick = () => closeOverlay('panier-overlay');
    $('panier-overlay').onclick = e => { if(e.target===$('panier-overlay')) closeOverlay('panier-overlay'); };
    $('zone-select').onchange = updateLivraison;
    $('btn-payer').onclick = initierPaiement;
    $('btn-appliquer-promo').onclick = appliquerCodePromo;
    $('btn-copier').onclick = () => {
        navigator.clipboard.writeText($('code-display').textContent).then(() => {
            $('btn-copier').textContent='✅ Copié !';
            setTimeout(()=>$('btn-copier').textContent='📋 Copier le code',2000);
        });
    };
    $('btn-fermer-code').onclick = () => { closeOverlay('code-overlay'); fermerWidgetIkeepay(); panier=[]; updatePanierBtn(); syncPanierServeur(); };
    $('btn-copier-success').onclick = () => {
        navigator.clipboard.writeText($('success-code-display').textContent).then(() => {
            $('btn-copier-success').textContent='✅ Copié !';
            setTimeout(()=>$('btn-copier-success').textContent='📋 Copier le code',2000);
        });
    };
    $('btn-fermer-success').onclick = () => { closeOverlay('success-overlay'); fermerWidgetIkeepay(); panier=[]; updatePanierBtn(); syncPanierServeur(); };

    $('btn-reserver').onclick = reserverCommande;
    $('btn-copier-reservation').onclick = () => {
        navigator.clipboard.writeText($('reservation-code-display').textContent).then(() => {
            $('btn-copier-reservation').textContent='✅ Copié !';
            setTimeout(()=>$('btn-copier-reservation').textContent='📋 Copier le code',2000);
        });
    };
    $('btn-fermer-reservation').onclick = () => closeOverlay('reservation-overlay');
}

// Réserve les articles du panier avec un code, AVANT tout choix de zone de
// livraison ou ajout de frais — aucun paiement effectué à ce stade.
async function reserverCommande() {
    if (!panier.length) { notifier('Ton panier est vide.', 'info'); return; }
    if (!currentUser) {
        inviteInfo = await demanderInfosInvite();
        if (!inviteInfo) return; // annulé
    } else {
        inviteInfo = null;
    }
    const btn = $('btn-reserver');
    btn.disabled = true; btn.textContent = 'Réservation en cours...';
    try {
        // Le serveur relit les vrais prix produits et calcule lui-même le
        // total — le navigateur n'envoie que les id + quantités.
        const headers = { 'Content-Type': 'application/json' };
        if (currentUser) {
            const fbUser = await attendreFirebaseUser();
            if (!fbUser) throw new Error('Ta session a expiré, reconnecte-toi puis réessaie.');
            headers['Authorization'] = 'Bearer ' + await fbUser.getIdToken();
        }
        const resp = await fetch(CONFIG.API.PREPARER_PAIEMENT, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                items: panier.map(p => ({ id: p.id, qty: p.qty, combo_id: p.combo_id })),
                reservation: true,
                code_promo: ($('promo-input').value || '').trim() || undefined,
                invite: inviteInfo,
                visiteur_session_id: visiteurId
            })
        });
        const result = await resp.json();
        if (!result.success) throw new Error(result.error || 'Impossible de réserver.');
        $('reservation-code-display').textContent = result.code;
        $('invite-nudge-reservation').style.display = (inviteInfo && !currentUser) ? 'block' : 'none';
        closeOverlay('panier-overlay');
        openOverlay('reservation-overlay');
    } catch (e) {
        notifier('❌ ' + (e.message || 'Erreur lors de la réservation. Réessaie.'), 'erreur');
    } finally {
        btn.disabled = false; btn.textContent = '📌 Réserver ma commande (sans payer maintenant)';
    }
}

function openPanier() {
    const items = $('panier-items');
    if (!panier.length) {
        items.innerHTML='<div class="panier-vide">Votre panier est vide. 🛒</div>';
        $('panier-totaux').innerHTML='';
        $('btn-payer').style.display='none';
        $('btn-reserver').style.display='none';
    } else {
        $('btn-payer').style.display='';
        $('btn-reserver').style.display='';
        renderPanier();
    }
    openOverlay('panier-overlay');
}

let codePromoApplique = null; // { code, reduction, sousTotal } — remis à zéro dès que le panier change

// Ouvre le formulaire d'inscription avec nom/téléphone déjà remplis, à
// partir des infos données lors d'un achat invité juste avant.
window.ouvrirSignupApresInvite = () => {
    if (!inviteInfo) return;
    closeOverlay('success-overlay'); closeOverlay('reservation-overlay');
    openOverlay('auth-overlay');
    $('atab-reg').click();
    $('reg-nom').value = inviteInfo.nom;
    $('reg-tel').value = inviteInfo.telephone.replace(/^237/,'').replace(/^\+237/,'').slice(-9);
};

// Demande nom + téléphone à un visiteur non connecté qui veut payer ou
// réserver sans créer de compte. Retourne { nom, telephone } ou null si annulé.
function demanderInfosInvite() {
    return new Promise((resolve) => {
        const el = document.createElement('div');
        el.className = 'modal-overlay';
        el.style.cssText = 'display:flex;z-index:6000;position:fixed;inset:0;background:rgba(0,0,0,0.6);align-items:center;justify-content:center;padding:16px';
        el.innerHTML = `<div style="background:white;border-radius:16px;max-width:360px;width:100%;padding:24px">
            <h3 style="font-size:1rem;margin-bottom:6px">👋 Presque fini !</h3>
            <p style="font-size:0.8rem;color:#888;margin-bottom:14px">Pas besoin de créer un compte — juste ton nom et ton numéro pour organiser la livraison.</p>
            <input id="invite-nom" placeholder="Ton nom" style="width:100%;padding:11px;border-radius:8px;border:1.5px solid #ddd;margin-bottom:8px;box-sizing:border-box;font-family:var(--font-body)">
            <input id="invite-tel" type="tel" placeholder="6XXXXXXXX" style="width:100%;padding:11px;border-radius:8px;border:1.5px solid #ddd;margin-bottom:6px;box-sizing:border-box;font-family:var(--font-body)">
            <p id="invite-err" style="color:var(--danger);font-size:0.75rem;min-height:16px;margin-bottom:6px"></p>
            <button id="invite-ok" style="width:100%;background:var(--green);color:white;border:none;padding:12px;border-radius:10px;font-weight:700;cursor:pointer;font-family:var(--font-title)">Continuer</button>
            <button id="invite-annuler" style="width:100%;background:none;border:none;color:#999;padding:8px;cursor:pointer;font-size:0.8rem">Annuler — j'ai déjà un compte / je préfère en créer un</button>
        </div>`;
        document.body.appendChild(el);
        el.querySelector('#invite-annuler').onclick = () => { el.remove(); resolve(null); };
        el.querySelector('#invite-ok').onclick = () => {
            const nom = el.querySelector('#invite-nom').value.trim();
            const telephone = el.querySelector('#invite-tel').value.trim();
            const err = el.querySelector('#invite-err');
            if (!nom) { err.textContent = 'Indique ton nom.'; return; }
            if (telephone.length < 8) { err.textContent = 'Numéro de téléphone invalide.'; return; }
            el.remove(); resolve({ nom, telephone });
        };
    });
}

function renderPanier() {
    const items = $('panier-items');
    items.innerHTML='';
    let sousTotal=0;
    panier.forEach((item,i)=>{
        const st=item.prix*item.qty; sousTotal+=st;
        const d=document.createElement('div');
        d.className='panier-item';
        const ligneprix = (item.combo_id && item.prix === 0) ? '🎁 Inclus dans le combo' : `${fmt(item.prix)} FCFA × ${item.qty}`;
        d.innerHTML=`<div class="panier-item-info"><strong>${item.name}</strong>${item.combo_id ? `<span style="color:var(--orange);font-size:0.7rem;font-weight:700"> — ${item.combo_nom}</span>` : ''}<span>${ligneprix}</span></div>
            <div class="panier-item-price">${fmt(st)} FCFA</div>
            <button class="btn-rm" data-idx="${i}" title="${item.combo_id ? 'Retire tout le kit' : 'Retirer'}">✕</button>`;
        d.querySelector('.btn-rm').onclick = e => {
            const idx = parseInt(e.target.dataset.idx);
            const cible = panier[idx];
            if (cible && cible.combo_id) {
                // Retire tout le kit d'un coup : laisser un combo incomplet
                // afficherait un prix qui ne correspondrait plus à ce que le
                // serveur facturera réellement au moment de payer.
                panier = panier.filter(p => p.combo_id !== cible.combo_id);
            } else {
                panier.splice(idx, 1);
            }
            updatePanierBtn(); syncPanierServeur(); openPanier();
        };
        items.appendChild(d);
    });
    // Le panier a changé : une réduction déjà affichée ne correspond plus
    // forcément aux bonnes règles (montant minimum, etc.) — on la retire de
    // l'affichage, le serveur revalidera de toute façon au moment de payer.
    if (codePromoApplique && codePromoApplique.sousTotal !== sousTotal) {
        codePromoApplique = null;
        $('promo-message').textContent = '';
    }
    updateTotaux(sousTotal);
}

async function appliquerCodePromo() {
    const saisi = ($('promo-input').value || '').trim();
    const msg = $('promo-message');
    if (!saisi) { codePromoApplique = null; msg.textContent = ''; renderPanier(); return; }

    const sousTotal = panier.reduce((s,p)=>s+p.prix*p.qty,0);
    msg.style.color = 'var(--text3)'; msg.textContent = 'Vérification du code...';
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (currentUser) {
            const fbUser = await attendreFirebaseUser();
            if (!fbUser) throw new Error('Ta session a expiré, reconnecte-toi puis réessaie.');
            headers['Authorization'] = 'Bearer ' + await fbUser.getIdToken();
        }
        const resp = await fetch(CONFIG.API.PREPARER_PAIEMENT, {
            method: 'POST',
            headers,
            body: JSON.stringify({ items: panier.map(p => ({ id: p.id, qty: p.qty, combo_id: p.combo_id })), code_promo: saisi, preview: true })
        });
        const result = await resp.json();
        if (!result.success || !result.code_valide) {
            codePromoApplique = null;
            msg.style.color = 'var(--danger)';
            msg.textContent = '❌ ' + (result.message || result.error || 'Code invalide.');
        } else {
            codePromoApplique = { code: saisi, reduction: result.reduction, sousTotal };
            msg.style.color = 'var(--success)';
            msg.textContent = '✅ ' + result.message;
        }
    } catch (e) {
        codePromoApplique = null;
        msg.style.color = 'var(--danger)';
        msg.textContent = 'Erreur de vérification, réessaie.';
    }
    updateTotaux(sousTotal);
}

// Montants exacts, tels que le serveur les facturera (même règle : prix réels).
// `sousTotal` = somme des prix AFFICHÉS (sert seulement à reconnaître le code promo déjà validé).
function calculerMontants(sousTotal) {
    const reduction = (codePromoApplique && codePromoApplique.sousTotal === sousTotal) ? codePromoApplique.reduction : 0;
    const sousReel = panier.reduce((s, p) => s + prixReelLigne(p) * p.qty, 0);
    return { reduction, sousReel, total: Math.max(0, sousReel - reduction) + fraisLivraison };
}

function updateTotaux(sousTotal) {
    const { reduction, sousReel, total } = calculerMontants(sousTotal);
    const ecart = sousReel - sousTotal; // arrondi entre prix affichés et prix réels
    $('panier-totaux').innerHTML=`<div class="totaux-box">
        <div class="total-ligne"><span>Sous-total</span><span>${fmt(sousTotal)} FCFA</span></div>
        ${ecart !== 0 ? `<div class="total-ligne"><span>Ajustement d'arrondi</span><span>${ecart > 0 ? '+' : '-'}${fmt(Math.abs(ecart))} FCFA</span></div>` : ''}
        ${reduction > 0 ? `<div class="total-ligne" style="color:var(--success)"><span>Réduction</span><span>-${fmt(reduction)} FCFA</span></div>` : ''}
        <div class="total-ligne"><span>Livraison</span><span>${fraisLivraison>0?fmt(fraisLivraison)+' FCFA':'—'}</span></div>
        <div class="total-final"><span>Total à payer</span><span>${fmt(total)} FCFA</span></div>
    </div>`;
}

function updateLivraison(sansSync) {
    const zone=$('zone-select').value;
    userZone=zone;
    const couverte = CONFIG.ZONES_COUVERTES.includes(zone);
    fraisLivraison = zone==='retrait' ? 0 : (couverte ? CONFIG.FRAIS_LIVRAISON : 0);
    const info=$('livraison-info');
    const warn=$('zone-warning');
    if(zone==='retrait'){
        info.style.display='block';
        info.className='livraison-info lv-ok';
        info.textContent='🏪 Retrait gratuit en boutique';
        warn.style.display='none';
    } else if(zone && couverte){
        info.style.display='block';
        info.className='livraison-info lv-pay';
        info.textContent=`🚚 Livraison à ${zone} : ${fmt(CONFIG.FRAIS_LIVRAISON)} FCFA`;
        warn.style.display='none';
    } else if(zone && !couverte){
        // Quartier hors zone de livraison directe : on n'empêche pas le paiement,
        // on informe simplement que le retrait se fera en agence.
        info.style.display='none';
        warn.style.display='block';
        warn.textContent=`ℹ️ Note : votre zone (${zone}) n'est pas couverte par notre livraison à domicile. En payant, vous acceptez de récupérer votre commande à notre agence (${CONFIG.AGENCE_ADRESSE}).`;
    } else {
        info.style.display='none';
        warn.style.display='none';
    }
    const regleEl = $('livraison-regle');
    if (regleEl) {
        regleEl.style.display = (zone && couverte) ? 'block' : 'none';
        regleEl.textContent = currentLang === 'en'
            ? 'ℹ️ After payment you give the exact drop-off spot. Absent 5 min after the appointment: collect at the agency, non-refundable.'
            : "ℹ️ Après ton paiement, tu indiques le lieu précis de livraison. Absent 5 min au rendez-vous : commande à récupérer à l'agence, non remboursable.";
    }
    if(panier.length) renderPanier();
    if (sansSync !== true) syncPanierServeur(); // (sansSync peut être un événement : on teste === true)
}

// ===== PAIEMENT =====
let selectedOp = "MTN";

function setupPaiement() {
    $('pay-close').onclick = () => closeOverlay('pay-overlay');
    $('btn-pay-confirm').onclick = confirmerPaiement;
    $('ikeepay-close').onclick = fermerWidgetIkeepay;
    $('pay-mtn').onclick = () => { selectedOp='MTN'; $('pay-mtn').classList.add('active'); $('pay-orange').classList.remove('active'); };
    $('pay-orange').onclick = () => { selectedOp='ORANGE'; $('pay-orange').classList.add('active'); $('pay-mtn').classList.remove('active'); };
}

function fermerWidgetIkeepay() {
    $('ikeepay-overlay').style.display = 'none';
    $('ikeepay-iframe').src = '';
}

let inviteInfo = null; // rempli si achat sans compte (invité), sinon null

async function initierPaiement() {
    if (!userZone) { notifier('Choisissez votre zone de livraison.', 'info'); return; }
    if (!currentUser) {
        inviteInfo = await demanderInfosInvite();
        if (!inviteInfo) return; // annulé
    } else {
        inviteInfo = null;
    }
    const { total } = calculerMontants(panier.reduce((s,p)=>s+p.prix*p.qty,0));
    $('pay-amount').textContent = fmt(total) + ' FCFA';
    $('pay-status').textContent='';
    $('btn-pay-confirm').disabled=false;
    $('btn-pay-confirm').textContent='Payer maintenant';
    // Le formulaire numéro+opérateur n'a de sens qu'en mode H2H —
    // en mode widget, iKeePay gère ça lui-même dans sa fenêtre.
    const modeH2H = CONFIG.PAIEMENT_MODE === 'h2h';
    $('pay-methods-h2h').style.display = modeH2H ? 'flex' : 'none';
    $('pay-tel-wrap').style.display = modeH2H ? 'block' : 'none';
    if (modeH2H) $('pay-tel').value = (currentUser ? currentUser.telephone : inviteInfo.telephone) || '';
    closeOverlay('panier-overlay');
    openOverlay('pay-overlay');
}

async function confirmerPaiement() {
    const status = $('pay-status');
    const btn = $('btn-pay-confirm');
    const modeH2H = CONFIG.PAIEMENT_MODE === 'h2h';

    let tel = '';
    if (modeH2H) {
        tel = $('pay-tel').value.trim();
        if (tel.length!==9 || !/^6\d{8}$/.test(tel)) { status.style.color='var(--danger)'; status.textContent='❌ Numéro invalide (9 chiffres, commence par 6)'; return; }
    }

    btn.disabled=true; btn.textContent='Traitement...';
    status.style.color='var(--text3)'; status.textContent='📲 Préparation du paiement...';
    try {
        if (modeH2H) {
            // Mode H2H (non actif actuellement — CONFIG.PAIEMENT_MODE = 'widget')
            throw new Error('Ce mode de paiement n\'est pas disponible actuellement.');
        }

        // Mode widget : le serveur recalcule lui-même le total à partir des
        // vrais prix produits, crée la commande, et génère le code — le
        // navigateur n'envoie que les id + quantités du panier.
        const headers = { 'Content-Type':'application/json' };
        if (currentUser) {
            const fbUser = await attendreFirebaseUser();
            if (!fbUser) throw new Error('Ta session a expiré, reconnecte-toi puis réessaie.');
            headers['Authorization'] = 'Bearer ' + await fbUser.getIdToken();
        }
        const resp = await fetch(CONFIG.API.PREPARER_PAIEMENT, {
            method:'POST',
            headers,
            body:JSON.stringify({
                items: panier.map(p => ({ id: p.id, qty: p.qty, combo_id: p.combo_id })),
                zone_livraison: userZone,
                frais_livraison: fraisLivraison,
                note: $('note-cmd').value || null,
                code_promo: ($('promo-input').value || '').trim() || undefined,
                invite: inviteInfo,
                visiteur_session_id: visiteurId
            })
        });
        const result = await resp.json();
        if (!result.success) throw new Error(result.error||'Échec paiement');
        const code = result.order_id;
        sessionStorage.setItem('cmkt_panier_'+code, JSON.stringify({ items: panier, total: result.amount, zone: userZone, frais: fraisLivraison }));
        status.textContent=''; btn.disabled=false; btn.textContent='Payer maintenant';
        ouvrirWidgetIkeepay(result, code);
    } catch(e) {
        status.style.color='var(--danger)'; status.textContent='❌ '+(e.message||'Erreur. Réessayez.');
        btn.disabled=false; btn.textContent='Payer maintenant';
    }
}

// Ouvre le widget iKeePay en overlay (iframe intégrée, aucune redirection externe)
// Reprend le paiement d'une commande déjà créée (retrouvée via son code
// dans "Mes Commandes"), sans repasser par le panier. Réutilise exactement
// le même circuit que pour une commande neuve : montant revérifié côté
// serveur, widget iKeePay, confirmation par webhook.
window.payerCommandeExistante = async (code) => {
    closeOverlay('cmds-overlay');
    try {
        const fbUser = await attendreFirebaseUser();
        if (!fbUser) { notifier('❌ Ta session a expiré, reconnecte-toi puis réessaie.', 'erreur'); return; }
        const idToken = await fbUser.getIdToken();
        const resp = await fetch(CONFIG.API.PREPARER_PAIEMENT, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
            body: JSON.stringify({ reference: code })
        });
        const result = await resp.json();
        if (!result.success) { notifier('❌ ' + (result.error || 'Impossible de préparer le paiement.'), 'erreur'); return; }
        ouvrirWidgetIkeepay(result, code);
    } catch (e) {
        notifier('❌ ' + (e.message || 'Erreur, réessaie.'), 'erreur');
    }
};

function ouvrirWidgetIkeepay(paiement, code) {
    const params = new URLSearchParams({
        pk: paiement.pk,
        amount: String(paiement.amount),
        currency: paiement.currency,
        order_id: paiement.order_id,
        country: 'CM' // Cameroun explicite — évite de dépendre uniquement de la sélection visuelle dans le widget
    });
    if (paiement.email) params.set('email', paiement.email);
    $('ikeepay-iframe').src = `https://ikeepay.com/checkout/v1/inline?${params.toString()}`;
    $('ikeepay-overlay').style.display = 'flex';

    // On ne fait plus reposer TOUTE la confirmation sur le signal
    // "ikeepay-success" de la fenêtre — avec le Mobile Money, la validation
    // passe souvent par un code USSD sur le téléphone du client, et ce
    // signal n'arrive pas toujours de façon fiable. La vérification démarre
    // donc dès l'ouverture, en parallèle, directement contre notre serveur
    // (qui lui reçoit le vrai webhook de paiement d'iKeePay).
    attendreConfirmationCommande(code);

    const onMessage = (event) => {
        if (event.data === 'ikeepay-close') {
            fermerWidgetIkeepay();
        }
        if (event.data === 'ikeepay-success') {
            window.removeEventListener('message', onMessage);
            fermerWidgetIkeepay();
            // La vérification en arrière-plan est déjà en cours — on ne la
            // relance pas, elle affichera le succès dès que confirmé.
        }
    };
    window.addEventListener('message', onMessage);
}

// Après le signal "succès" du widget, on attend la confirmation réelle du
// webhook côté serveur (jamais fait confiance au seul message de l'iframe,
// qui ne prouve rien côté serveur) avant d'afficher la page de succès.
async function attendreConfirmationCommande(code, tentative = 0) {
    let resa = null;
    try {
        const resp = await fetch(CONFIG.API.PREPARER_PAIEMENT, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ suivi: { code } })
        });
        const result = await resp.json();
        if (result.success) resa = result.commande;
    } catch (e) {}
    if (resa?.statut === 'valide') {
        fermerWidgetIkeepay();
        afficherSuccesDepuisResa(resa);
        return;
    }
    if (resa?.statut === 'paiement_echoue') {
        fermerWidgetIkeepay();
        notifier('❌ Le paiement a échoué ou a été annulé. Tu peux réessayer depuis ton panier.', 'erreur');
        return;
    }
    // Le Mobile Money demande souvent une confirmation par code USSD sur le
    // téléphone du client — ça peut prendre un moment. On vérifie toutes les
    // 3 secondes pendant les 2 premières minutes, puis toutes les 8 secondes
    // pendant encore ~4 minutes (au cas où le client met du temps à
    // confirmer), avant d'abandonner et de proposer "Mes commandes".
    const dureeRapide = 40, dureeLente = 30;
    if (tentative >= dureeRapide + dureeLente) {
        notifier('⏳ Paiement toujours en attente de confirmation. Vérifie le statut dans "Mes commandes" dans quelques instants — ta commande sera validée automatiquement dès la confirmation reçue.', 'info');
        return;
    }
    const delai = tentative < dureeRapide ? 3000 : 8000;
    setTimeout(() => attendreConfirmationCommande(code, tentative + 1), delai);
}

// (ancienne gestion du retour de redirection GeniusPay supprimée — le widget
// iKeePay reste sur la page, la confirmation passe par attendreConfirmationCommande())

// Affiche la page de succès à partir d'une commande déjà enregistrée en base
// (utilisé au retour de paiement, quand le panier en mémoire a été perdu par la redirection)
function afficherSuccesDepuisResa(resa) {
    syncBadgeCommandes(window._mesCommandes ? window._mesCommandes.filter(r => r.code !== resa.code) : []);
    const sauvegarde = sessionStorage.getItem('cmkt_panier_'+resa.code);
    if (sauvegarde) {
        const d = JSON.parse(sauvegarde);
        panier = d.items; userZone = d.zone; fraisLivraison = d.frais;
        sessionStorage.removeItem('cmkt_panier_'+resa.code);
    } else {
        panier = (resa.items||[]).map(i => ({ id:i.id, name:i.name, qty:i.qty, prix:i.prix, prix_reel:i.prix }));
        userZone = resa.zone_livraison; fraisLivraison = resa.frais_livraison || 0;
    }
    afficherSucces(resa.code, resa.total, resa.date_limite_retrait);
    panier = []; updatePanierBtn(); syncPanierServeur();
}

function afficherCode(code, total) {
    $('code-display').textContent = code;
    let html=panier.map(p=>`<div class="recap-ligne"><span>${p.name} ×${p.qty}</span><span>${fmt(prixReelLigne(p)*p.qty)} F</span></div>`).join('');
    if(fraisLivraison>0) html+=`<div class="recap-ligne"><span>🚚 Livraison (${userZone})</span><span>${fmt(fraisLivraison)} F</span></div>`;
    html+=`<div class="recap-total"><span>Total</span><span>${fmt(total)} FCFA</span></div>`;
    $('code-recap').innerHTML=html;
    closeOverlay('panier-overlay');
    openOverlay('code-overlay');
}

// Page de succès affichée après confirmation d'un paiement (mobile money via iKeePay)
// Construit l'animation "ce qui a été acheté" affichée sur l'écran de succès :
// miniatures des produits + un petit camion (livraison) ou un carton qui se
// ferme (retrait en agence), pour que le client visualise concrètement son achat.
function construireAnimationSucces(items, estLivraisonDomicile) {
    const vignettes = items.filter(i => i.image_url).slice(0, 4)
        .map((i, idx) => `<div class="success-anim-item" style="animation-delay:${(0.15 + idx * 0.15).toFixed(2)}s"><img src="${i.image_url}" alt="${i.name}"></div>`).join('');
    if (!vignettes) return ''; // pas d'image dispo pour ces articles : pas d'animation forcée
    if (estLivraisonDomicile) {
        return `<div class="success-anim"><div class="success-anim-items">${vignettes}</div><div class="success-anim-road"><span class="success-anim-truck">🚚</span></div></div>`;
    }
    return `<div class="success-anim"><div class="success-anim-items">${vignettes}</div><div class="success-anim-box">📦</div></div>`;
}

// ===== INFOS DE LIVRAISON (demandées au client après le paiement) =====
// Quartier (rappel) + endroit précis + numéro WhatsApp avec ses deux cases + règle des 5 minutes.
// Les infos vont sur la facture et dans le groupe des livreurs (voir api/preparer-paiement.js).
const regleLivraison = () => currentLang === 'en'
    ? "If you are not there 5 minutes after the appointment time set with the courier, your order goes back to the agency. You will have to collect it there (within 7 days). It will then no longer be refundable and the return policy will no longer apply, except in case of fault by Kapmaket."
    : "Si tu n'es pas présent 5 minutes après l'heure du rendez-vous fixé avec le livreur, ta commande retourne à l'agence. Tu devras venir la récupérer sur place (sous 7 jours). Elle ne sera alors plus remboursable et la politique de retour ne s'appliquera plus, sauf faute de Kapmaket.";
const livraisonVerrouillee = r => ['en_route', 'livree'].includes(r.etape_livraison) || r.statut === 'livre';
const estLivraisonDomicileCmd = r => CONFIG.ZONES_COUVERTES.includes(r.zone_livraison);

// Contenu du petit bloc « livraison » des cartes de « Mes commandes » et du suivi (commande payée à livrer)
function blocLivraisonCarte(r) {
    if (!r || r.statut !== 'valide' || !estLivraisonDomicileCmd(r)) return '';
    const en = currentLang === 'en', code = echapperHtml(r.code);
    if (r.livraison_repere) {
        return `<div class="liv-resume">📍 <b>${echapperHtml(r.zone_livraison)} (${echapperHtml(r.livraison_repere)})</b><br>💬 ${echapperHtml(r.livraison_whatsapp || '')}${livraisonVerrouillee(r) ? '' : ` <button type="button" class="liv-lien" onclick="ouvrirInfosLivraison('${code}')">${en ? 'Edit' : 'Modifier'}</button>`}</div>`;
    }
    return `<button type="button" class="liv-cta" onclick="ouvrirInfosLivraison('${code}')">📍 ${en ? 'Tell us where to deliver' : 'Indique où te livrer'}</button>`;
}

async function ouvrirInfosLivraison(code, { quandFerme } = {}) {
    code = String(code || '').trim().toUpperCase();
    if (!code || document.getElementById('liv-panel')) return;
    const T = phT;
    const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    const bouton = (txt, cls, fn) => { const b = el('button', cls, txt); b.type = 'button'; b.addEventListener('click', fn); return b; };
    const ancienScroll = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const ov = el('div', 'photo-overlay'); ov.id = 'liv-panel';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'liv-titre');
    const feuille = el('div', 'photo-sheet'), tete = el('div', 'photo-head');
    const titre = el('h3', null, T('📍 Où te livrer ?', '📍 Where to deliver?')); titre.id = 'liv-titre';
    const btnX = bouton('✕', 'photo-x', () => fermer()); btnX.setAttribute('aria-label', T('Fermer', 'Close'));
    tete.append(titre, btnX);
    const corps = el('div', 'photo-body');
    feuille.append(tete, corps); ov.append(feuille); document.body.append(ov);

    let cmd = null, occupe = false, enregistre = false;
    function fermer() {
        document.removeEventListener('keydown', surTouche);
        document.body.style.overflow = ancienScroll; ov.remove();
        if (typeof quandFerme === 'function') { try { quandFerme(enregistre); } catch (e) {} }
    }
    function surTouche(e) { if (e.key === 'Escape' && !occupe) fermer(); }
    document.addEventListener('keydown', surTouche);

    async function appel(corpsRequete) {
        const ctrl = new AbortController(); const m = setTimeout(() => ctrl.abort(), 15000);
        try {
            const resp = await fetch('/api/preparer-paiement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpsRequete), signal: ctrl.signal });
            let data = null; try { data = await resp.json(); } catch (e) {}
            return { ok: !!(resp.ok && data && data.success), data };
        } catch (e) { return { ok: false, data: null }; }
        finally { clearTimeout(m); }
    }
    function message(txt, reessayer) {
        corps.replaceChildren(el('div', 'photo-ico', 'ℹ️'), el('p', 'photo-etat', txt));
        const rang = el('div', 'photo-choix');
        if (reessayer) rang.append(bouton(T('Réessayer', 'Try again'), 'photo-btn photo-btn-main', charger));
        rang.append(bouton(T('Fermer', 'Close'), 'photo-btn photo-btn-sec', () => fermer()));
        corps.append(rang);
    }
    function recap({ nouveau, verrouille } = {}) {
        corps.replaceChildren(el('div', 'photo-ico', nouveau ? '✅' : '📍'));
        if (nouveau) corps.append(el('p', 'photo-etat', T("C'est enregistré : le livreur est prévenu.", 'Saved: the courier has been notified.')));
        const bloc = el('div', 'liv-resume');
        bloc.append(el('div', null, '📌 ' + cmd.zone_livraison + ' (' + cmd.livraison_repere + ')'),
            el('div', null, '💬 ' + (cmd.livraison_whatsapp || '') + (cmd.livraison_whatsapp_ok ? ' · ✅ WhatsApp' : '') + (cmd.livraison_appels_ok ? ' · 📞 ' + T('appels OK', 'calls OK') : '')));
        corps.append(bloc);
        const rang = el('div', 'photo-choix');
        if (verrouille) {
            corps.append(el('p', 'photo-note', T('Ta commande est en route : pour modifier ces informations, écris-nous sur WhatsApp.', 'Your order is on its way: to change this information, message us on WhatsApp.')));
            const wa = el('a', 'photo-btn', '💬 WhatsApp');
            wa.href = 'https://wa.me/' + CONFIG.AGENCE_TEL + '?text=' + encodeURIComponent('Bonjour, je souhaite modifier les infos de livraison de ma commande ' + code);
            wa.target = '_blank'; wa.rel = 'noopener'; rang.append(wa);
        } else {
            corps.append(el('p', 'photo-note', T('Tu peux modifier ces informations tant que le livreur n’est pas en route.', 'You can edit this information until the courier is on their way.')));
            rang.append(bouton(T('Modifier', 'Edit'), 'photo-btn', formulaire));
        }
        rang.append(bouton(T('Fermer', 'Close'), 'photo-btn photo-btn-main', () => fermer()));
        corps.append(rang);
    }
    function formulaire() {
        corps.replaceChildren(el('p', 'photo-intro', T('Dernière étape : dis-nous où déposer ta commande.', 'Last step: tell us where to drop off your order.')));
        const quartier = el('div', 'liv-quartier');
        quartier.append(el('span', 'liv-lib', T('Ton quartier (choisi à la commande)', 'Your area (chosen at checkout)')), el('b', null, cmd.zone_livraison));
        const champ = (lib, input, aide) => { const w = el('label', 'liv-champ'); w.append(el('span', 'liv-lib', lib), input); if (aide) w.append(el('small', 'liv-aide', aide)); return w; };
        const repere = el('input'); repere.type = 'text'; repere.maxLength = 120; repere.autocomplete = 'off';
        repere.placeholder = T('Ex : Glacier Moderne, en face de la pharmacie', 'E.g. Glacier Moderne, opposite the pharmacy'); repere.value = cmd.livraison_repere || '';
        const wa = el('input'); wa.type = 'tel'; wa.inputMode = 'tel'; wa.autocomplete = 'tel'; wa.placeholder = '6 99 78 11 60';
        wa.value = cmd.livraison_whatsapp || (currentUser && currentUser.telephone) || '';
        const coche = (txt, val) => { const l = el('label', 'liv-coche'); const c = el('input'); c.type = 'checkbox'; c.checked = !!val; l.append(c, el('span', null, txt)); return { l, c }; };
        const c1 = coche(T('Ce numéro est sur WhatsApp', 'This number is on WhatsApp'), cmd.livraison_whatsapp_ok);
        const c2 = coche(T('Je reçois les appels à n’importe quel moment', 'I can receive calls at any time'), cmd.livraison_appels_ok);
        const regle = el('div', 'liv-regle'); regle.append(el('b', null, '⏱ ' + T('Important', 'Important')), el('p', null, regleLivraison()));
        const err = el('p', 'liv-erreur'); err.setAttribute('role', 'alert');
        const libValider = '✅ ' + T('Valider et accepter cette règle', 'Confirm and accept this rule');
        const valider = bouton(libValider, 'photo-btn photo-btn-main', async () => {
            err.textContent = '';
            const rp = repere.value.replace(/\s+/g, ' ').trim();
            const chiffres = wa.value.replace(/\D/g, '');
            if (rp.length < 3) { err.textContent = T("Indique l'endroit précis où déposer ta commande.", 'Enter the exact spot where to drop off your order.'); return; }
            if (!(chiffres.length === 9 || (chiffres.length >= 10 && chiffres.length <= 15))) { err.textContent = T('Numéro WhatsApp invalide (exemple : 6 99 78 11 60).', 'Invalid WhatsApp number (example: 6 99 78 11 60).'); return; }
            occupe = true; valider.disabled = true; valider.textContent = T('Enregistrement…', 'Saving…');
            const r = await appel({ infos_livraison: { code, repere: rp, whatsapp: wa.value, whatsapp_ok: c1.c.checked, appels_ok: c2.c.checked, accepte: true } });
            occupe = false;
            if (!r.ok) {
                valider.disabled = false; valider.textContent = libValider;
                err.textContent = (r.data && r.data.error) || T('Enregistrement impossible, vérifie ta connexion et réessaie.', 'Could not save, check your connection and try again.');
                return;
            }
            cmd = r.data.commande; enregistre = true;
            if (Array.isArray(window._mesCommandes)) { const o = window._mesCommandes.find(x => x.code === cmd.code); if (o) Object.assign(o, cmd); }
            document.querySelectorAll('.liv-slot[data-code="' + cmd.code + '"]').forEach(sl => { sl.innerHTML = blocLivraisonCarte(cmd); });
            recap({ nouveau: true });
        });
        corps.append(quartier,
            champ(T('Endroit précis où déposer la commande *', 'Exact drop-off spot *'), repere, T('Un lieu connu : restaurant, carrefour, pharmacie, église…', 'A well-known place: restaurant, junction, pharmacy, church…')),
            champ(T('Numéro WhatsApp pour te joindre *', 'WhatsApp number to reach you *'), wa),
            c1.l, c2.l, regle, err, valider,
            el('p', 'liv-aide liv-centre', T('En validant, tu acceptes cette règle.', 'By confirming, you accept this rule.')),
            bouton(T('Plus tard', 'Later'), 'photo-btn photo-btn-sec', () => fermer()));
        repere.focus();
    }
    async function charger() {
        corps.replaceChildren(el('div', 'photo-spinner'), el('p', 'photo-etat', T('Chargement…', 'Loading…')));
        const r = await appel({ suivi: { code } });
        if (!r.ok) return message((r.data && r.data.error) || T('Commande introuvable ou réseau lent. Réessaie.', 'Order not found or slow network. Try again.'), true);
        cmd = r.data.commande;
        if (!estLivraisonDomicileCmd(cmd)) return message(T('Cette commande est à retirer en agence : rien à renseigner.', 'This order is for pick-up at the agency: nothing to fill in.'));
        if (cmd.statut !== 'valide' && cmd.statut !== 'livre') return message(T("Le paiement n'est pas encore confirmé. Reviens dans un instant.", 'Payment not confirmed yet. Come back in a moment.'), true);
        if (livraisonVerrouillee(cmd)) return cmd.livraison_repere ? recap({ verrouille: true }) : message(T('Ta commande est déjà en route : le livreur te contactera directement.', 'Your order is already on its way: the courier will contact you directly.'));
        formulaire();
    }
    charger();
}
window.ouvrirInfosLivraison = ouvrirInfosLivraison;

function afficherSucces(code, total, dateLimiteRetrait) {
    fermerWidgetIkeepay();
    $('success-code-display').textContent = code;
    // Certains points d'ajout au panier (achat rapide sur la carte produit) ne
    // conservent pas l'image — on la retrouve ici via le catalogue si besoin.
    const itemsAffiches = panier.map(p => ({ ...p, image_url: p.image_url || allProducts.find(x => x.id === p.id)?.image_url }));
    const estLivraisonDomicile = CONFIG.ZONES_COUVERTES.includes(userZone);
    $('success-anim').innerHTML = construireAnimationSucces(itemsAffiches, estLivraisonDomicile);
    let html=itemsAffiches.map(p=>`<div class="recap-ligne"><span class="recap-ligne-label">${p.image_url?`<img src="${p.image_url}" class="recap-img" alt="">`:''}${p.name} ×${p.qty}</span><span>${fmt(prixReelLigne(p)*p.qty)} F</span></div>`).join('');
    if(fraisLivraison>0) html+=`<div class="recap-ligne"><span>🚚 Livraison (${userZone})</span><span>${fmt(fraisLivraison)} F</span></div>`;
    html+=`<div class="recap-total"><span>Total</span><span>${fmt(total)} FCFA</span></div>`;
    $('success-recap').innerHTML = html;
    $('success-agence-msg').textContent = estLivraisonDomicile
        ? `🚚 Livraison à domicile prévue à ${userZone}. Indique ci-dessous l'endroit précis de livraison : le livreur te contactera sur ton numéro WhatsApp. Besoin d'aide ? Contactez-nous au ${CONFIG.AGENCE_TEL.replace('237','')}.`
        : `Veuillez vous présenter à notre agence (${CONFIG.AGENCE_ADRESSE}) pour le retrait, ou contactez-nous au ${CONFIG.AGENCE_TEL.replace('237','')} pour organiser une expédition par agence de voyage si nécessaire.${dateLimiteRetrait ? ` ⏳ À retirer avant le ${new Date(dateLimiteRetrait).toLocaleDateString('fr-FR')} — passé ce délai, nous ne sommes plus garants de la marchandise.` : ''}`;
    $('success-wa').href = `https://wa.me/${CONFIG.AGENCE_TEL}?text=${encodeURIComponent('Bonjour, je viens de payer ma commande '+code+' sur Kapmaket.')}`;
    $('invite-nudge-success').style.display = (inviteInfo && !currentUser) ? 'block' : 'none';
    closeOverlay('panier-overlay');
    openOverlay('success-overlay');
    // Téléchargement automatique du reçu (avec photos des articles) dès que
    // le paiement est confirmé — fonctionne aussi pour un achat invité (voir
    // api/facture.js). Léger délai pour laisser l'écran de succès s'afficher
    // avant que le navigateur ne déclenche le téléchargement.
    let cta = document.getElementById('success-infos-liv');
    if (!cta) {
        cta = document.createElement('button'); cta.id = 'success-infos-liv'; cta.type = 'button'; cta.className = 'liv-cta';
        $('success-agence-msg').insertAdjacentElement('afterend', cta);
    }
    cta.style.display = estLivraisonDomicile ? 'block' : 'none';
    cta.textContent = '📍 ' + phT('Indiquer où te livrer', 'Tell us where to deliver');
    if (estLivraisonDomicile) {
        // La facture contient les infos de livraison : on la télécharge une fois le formulaire rempli (ou fermé).
        let factureTelechargee = false;
        const telecharger = () => { if (!factureTelechargee) { factureTelechargee = true; telechargerFacture(code); } };
        cta.onclick = () => ouvrirInfosLivraison(code, { quandFerme: telecharger });
        setTimeout(() => ouvrirInfosLivraison(code, { quandFerme: telecharger }), 900);
    } else {
        setTimeout(() => telechargerFacture(code), 600);
    }
}

// ===== AUTRES MODALS =====
function setupModals() {
    $('suivi-close').onclick = () => closeOverlay('suivi-overlay');
    $('loc-close').onclick = () => closeOverlay('loc-overlay');
    $('cmds-close').onclick = () => closeOverlay('cmds-overlay');
    $('btn-suivi').onclick = suivreCommande;
    $('btn-envoyer-retour').onclick = envoyerDemandeRetour;
    document.addEventListener('keydown', e => {
        if(e.key==='Escape') document.querySelectorAll('.modal-overlay').forEach(m=>m.style.display='none');
    });
}

async function suivreCommande() {
    const code=$('suivi-input').value.trim().toUpperCase();
    const res=$('suivi-result'); if(!code)return;
    res.innerHTML = '<p style="color:var(--text3)">Recherche...</p>';
    try {
        const resp = await fetch(CONFIG.API.PREPARER_PAIEMENT, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ suivi: { code } })
        });
        const result = await resp.json();
        if (!result.success) { res.innerHTML = '<p style="color:var(--danger)">❌ ' + (result.error || 'Code introuvable') + '</p>'; return; }
        const data = result.commande;
        const statuts={'en attente':'⏳ En attente','valide':'✅ Validée','livre':'🚚 Livrée','annule':'❌ Annulée','paiement_en_cours':'💳 Paiement en cours','reservee':'📌 Réservée'};
        res.innerHTML=`<div style="background:var(--bg);border-radius:10px;padding:14px;border:1px solid var(--border)">
            <div style="font-family:monospace;color:var(--green);font-weight:700;margin-bottom:6px">${data.code}</div>
            <div style="font-size:1.05rem;margin-bottom:6px">${statuts[data.statut]||data.statut}</div>
            <div style="color:var(--text3);font-size:0.82rem">📅 ${new Date(data.created_at).toLocaleString('fr-FR')}</div>
            <div style="color:var(--text3);font-size:0.82rem">📍 ${data.zone_livraison||'Non précisé'}</div>
            <div style="color:var(--green);font-weight:700;margin-top:8px">${fmt(data.total)} FCFA</div>
            <div class="liv-slot" data-code="${data.code}">${blocLivraisonCarte(data)}</div>
        </div>`;
    } catch (e) {
        res.innerHTML = '<p style="color:var(--danger)">❌ Erreur, réessaie.</p>';
    }
}

async function chargerCommandes() {
    if(!currentUser)return;
    try {
        const fbUser = await attendreFirebaseUser();
        if (!fbUser) { window._mesCommandes = []; return; }
        const idToken = await fbUser.getIdToken();
        const resp = await fetch(CONFIG.API.PREPARER_PAIEMENT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
            body: JSON.stringify({ mescommandes: true })
        });
        const result = await resp.json();
        window._mesCommandes = result.success ? (result.commandes || []) : [];
    } catch (e) {
        window._mesCommandes = [];
    }
    afficherMesCommandes(window._mesCommandes);
    openOverlay('cmds-overlay');
    syncBadgeCommandes(window._mesCommandes);
}

// Met à jour le badge sur l'icône de l'app (Android/Chrome uniquement,
// ignoré ailleurs) avec le nombre de commandes non payées.
function syncBadgeCommandes(liste) {
    if (!('setAppBadge' in navigator)) return;
    const nonPayees = (liste || []).filter(r => ['reservee','paiement_en_cours'].includes(r.statut)).length;
    navigator.setAppBadge(nonPayees > 0 ? nonPayees : 0).catch(() => {});
}

function afficherMesCommandes(liste) {
    const list=$('cmds-list');
    const septJours = 7*24*60*60*1000;
    list.innerHTML=!liste.length?'<p style="color:var(--text3);text-align:center;padding:20px">Aucune commande.</p>'
        :liste.map(r=>{
            const peutRetourner = r.statut==='livre' && (Date.now() - new Date(r.created_at).getTime()) < septJours;
            const estPaye = r.statut==='valide' || r.statut==='livre';
            const peutPayer = !estPaye && r.statut !== 'annule';
            return `<div style="background:var(--bg);border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;align-items:start">
                <div style="font-family:monospace;color:var(--green);font-weight:700">${r.code}</div>
                <button onclick="supprimerCommandeClient('${r.code}')" title="Retirer de mon historique" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:0.9rem;padding:0 2px">🗑️</button>
            </div>
            <div style="color:var(--text3);font-size:0.78rem;margin:4px 0">📅 ${new Date(r.created_at).toLocaleString('fr-FR')} • 📍 ${r.zone_livraison||'—'}</div>
            <span style="display:inline-block;padding:3px 12px;border-radius:10px;font-size:0.72rem;font-weight:700;background:${r.statut==='en attente'?'#fff8f0':estPaye?'#f0fff4':'#fff0f0'};color:${r.statut==='en attente'?'var(--orange)':estPaye?'var(--success)':'var(--danger)'}">${r.statut}</span>
            <div style="color:var(--text2);font-size:0.82rem;margin-top:6px">${r.items.map(i=>`${i.name} ×${i.qty}`).join(', ')}</div>
            <div style="color:var(--green);font-weight:700;margin-top:4px">${fmt(r.total)} FCFA</div>
            <div class="liv-slot" data-code="${r.code}">${blocLivraisonCarte(r)}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
                ${peutPayer ? `<button onclick="payerCommandeExistante('${r.code}')" style="background:linear-gradient(135deg,var(--orange),var(--orange-light));color:white;border:none;padding:9px 16px;border-radius:var(--radius-pill);font-size:0.82rem;font-weight:700;cursor:pointer;font-family:var(--font-title);letter-spacing:0.3px;box-shadow:0 3px 10px rgba(255,107,26,0.3)">💳 Payer maintenant</button>` : ''}
                <button onclick="telechargerFacture('${r.code}')" style="background:${peutPayer?'none':'linear-gradient(135deg,var(--green),var(--green-light))'};color:${peutPayer?'var(--text2)':'white'};border:${peutPayer?'1px solid var(--border)':'none'};padding:9px 16px;border-radius:var(--radius-pill);font-size:0.82rem;font-weight:700;cursor:pointer;font-family:${peutPayer?'var(--font-body)':'var(--font-title)'};letter-spacing:0.3px;${peutPayer?'':'box-shadow:0 3px 10px rgba(14,124,74,0.28)'}">⬇️ ${peutPayer?'Suivi':'Télécharger (Facture)'}</button>
                ${peutRetourner ? `<button onclick="ouvrirDemandeRetour('${r.id}','${r.code}')" style="background:none;border:1px solid var(--border);color:var(--text2);padding:6px 12px;border-radius:6px;font-size:0.78rem;cursor:pointer">🔄 Demander un retour</button>` : ''}
            </div>
        </div>`;}).join('');
}

window.rechercherMesCommandes = (q) => {
    q = q.trim().toLowerCase();
    const filtre = !q ? window._mesCommandes : window._mesCommandes.filter(r => r.code.toLowerCase().includes(q));
    afficherMesCommandes(filtre);
};

window.supprimerCommandeClient = async (code) => {
    if (!confirm(`Retirer la commande ${code} de ton historique ?\n\nElle reste consultable par le support si besoin, mais tu ne la verras plus ici.`)) return;
    try {
        const fbUser = await attendreFirebaseUser();
        if (!fbUser) { notifier('❌ Session expirée, reconnecte-toi puis réessaie.', 'erreur'); return; }
        const idToken = await fbUser.getIdToken();
        await fetch('/api/facture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
            body: JSON.stringify({ code, masquer: true })
        });
        chargerCommandes();
    } catch (e) {
        notifier('❌ Erreur', 'erreur');
    }
};

window.telechargerFacture = async (code) => {
    try {
        const fbUser = await attendreFirebaseUser();
        const headers = {};
        if (fbUser) headers['Authorization'] = 'Bearer ' + await fbUser.getIdToken();
        // Sans compte (achat invité), pas de jeton — l'endpoint autorise
        // alors l'accès via le code de commande lui-même (rate-limité par IP).
        const resp = await fetch(`/api/facture?code=${encodeURIComponent(code)}`, { headers });
        if (!resp.ok) { const j = await resp.json().catch(()=>({})); notifier('❌ ' + (j.error || 'Impossible de télécharger la facture'), 'erreur'); return; }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        try {
            const a = document.createElement('a');
            a.href = url; a.download = `facture-${code}.pdf`;
            document.body.appendChild(a); a.click(); a.remove();
        } catch (eDl) {
            // Repli si le téléchargement forcé est bloqué (fréquent dans
            // certaines apps installées/webviews) : ouvrir le PDF dans un
            // nouvel onglet, l'utilisateur peut l'enregistrer depuis là.
            window.open(url, '_blank');
        }
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
        console.error('Erreur téléchargement facture:', e);
        notifier('❌ Erreur lors du téléchargement : ' + (e.message || 'inconnue'), 'erreur');
    }
};



let retourReservationId = null;
window.ouvrirDemandeRetour = (reservationId, code) => {
    retourReservationId = reservationId;
    $('retour-code-affiche').textContent = code;
    $('retour-motif').value = '';
    $('retour-err').textContent = '';
    openOverlay('demande-retour-overlay');
};
async function envoyerDemandeRetour() {
    const motif = $('retour-motif').value.trim();
    const err = $('retour-err');
    if (!motif) { err.style.color='var(--danger)'; err.textContent = '❌ Explique brièvement le motif'; return; }
    try {
        const fbUser = await attendreFirebaseUser();
        if (!fbUser) throw new Error('Ta session a expiré, reconnecte-toi puis réessaie.');
        const idToken = await fbUser.getIdToken();
        const resp = await fetch('/api/facture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
            body: JSON.stringify({ type: 'retour', code: $('retour-code-affiche').textContent, motif })
        });
        const j = await resp.json();
        if (!resp.ok) throw new Error(j.error || 'Erreur');
        err.style.color='var(--success)'; err.textContent = '✅ Demande envoyée, on te recontacte rapidement.';
        setTimeout(() => closeOverlay('demande-retour-overlay'), 1500);
    } catch(e) { err.style.color='var(--danger)'; err.textContent = '❌ ' + e.message; }
}

// ===== EMOJIS → PETITES PHOTOS RÉELLES (Unsplash) =====
// Remplace, dans tout le site, chaque emoji listé dans CONFIG.ICON_PHOTOS par une miniature ronde
// <img class="cat-icon">. Si la photo ne charge pas, l'emoji d'origine est remis (jamais de cadre vide).
function creerIconePhoto(emoji) {
    const cfg = CONFIG.ICON_PHOTOS[emoji];
    const base = 'https://images.unsplash.com/' + cfg.id + '?fit=crop&q=60&auto=format';
    const img = document.createElement('img');
    img.className = 'cat-icon';
    img.src = base + '&w=48&h=48';
    img.srcset = base + '&w=48&h=48 1x, ' + base + '&w=96&h=96 2x';
    img.alt = cfg.alt; img.width = 22; img.height = 22;
    img.loading = 'lazy'; img.decoding = 'async';
    img.onerror = () => {
        const s = document.createElement('span');
        s.className = 'cat-icon-fallback'; s.setAttribute('data-no-photo', ''); s.textContent = emoji;
        img.replaceWith(s);
    };
    return img;
}
function remplacerEmojisParPhotos(racine) {
    const cles = Object.keys(CONFIG.ICON_PHOTOS || {});
    if (!cles.length || !racine || !racine.textContent) return;
    const re = new RegExp('(' + cles.join('|') + ')\\uFE0F?', 'g');
    if (!re.test(racine.textContent)) return;
    re.lastIndex = 0;
    const walker = document.createTreeWalker(racine, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
            const p = n.parentElement;
            if (!p || p.closest('script,style,textarea,input,option,[data-no-photo]')) return NodeFilter.FILTER_REJECT;
            re.lastIndex = 0;
            return re.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
    });
    const noeuds = []; while (walker.nextNode()) noeuds.push(walker.currentNode);
    noeuds.forEach(n => {
        const frag = document.createDocumentFragment(); let dernier = 0; re.lastIndex = 0; let m;
        const txt = n.nodeValue;
        while ((m = re.exec(txt))) {
            if (m.index > dernier) frag.appendChild(document.createTextNode(txt.slice(dernier, m.index)));
            frag.appendChild(creerIconePhoto(m[1]));
            dernier = m.index + m[0].length;
        }
        if (dernier < txt.length) frag.appendChild(document.createTextNode(txt.slice(dernier)));
        n.replaceWith(frag);
    });
}
document.addEventListener('DOMContentLoaded', () => {
    remplacerEmojisParPhotos(document.body);
    let file = new Set(), minuteur = null;
    new MutationObserver(muts => {
        muts.forEach(m => {
            if (m.type === 'characterData') { if (m.target.parentElement) file.add(m.target.parentElement); }
            else m.addedNodes.forEach(n => { if (n.nodeType === 1) file.add(n); else if (n.nodeType === 3 && n.parentElement) file.add(n.parentElement); });
        });
        if (!file.size || minuteur) return;
        minuteur = setTimeout(() => {
            const aTraiter = [...file]; file = new Set(); minuteur = null;
            aTraiter.forEach(el => { if (el.isConnected) remplacerEmojisParPhotos(el); });
        }, 120);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
});

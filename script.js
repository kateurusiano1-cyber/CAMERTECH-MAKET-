// ===== INIT SUPABASE =====
const db = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ===== ÉTAT =====
let currentUser = null, isAdmin = false, currentAdmin = null;
let favorisIds = new Set();
let allProducts = [], panier = [], modalProduct = null;
let selectedFile = null, selectedFilesAll = [], editingId = null, currentCat = "tous";
let userZone = "", fraisLivraison = 0;
let slideIndex = 0, slideTimer = null, totalSlides = 1;
let selectedNote = 0, avisFile = null;

// ===== COMPRESSION IMAGE =====
async function compresserImage(file) {
    return new Promise(res => {
        const reader = new FileReader();
        reader.onload = e => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let w = img.width, h = img.height;
                const max = 1600;
                if (w > max || h > max) {
                    const r = Math.min(max/w, max/h);
                    w = Math.round(w*r); h = Math.round(h*r);
                }
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                canvas.toBlob(b => res(b), 'image/webp', 0.88);
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

async function uploadImage(file) {
    const blob = await compresserImage(file);
    const name = Date.now() + '-' + Math.random().toString(36).substring(2) + '.webp';
    const { data, error } = await db.storage.from(CONFIG.BUCKET).upload(name, blob, { contentType: 'image/webp' });
    if (error) throw error;
    return db.storage.from(CONFIG.BUCKET).getPublicUrl(data.path).data.publicUrl;
}

// ===== UTILITAIRES =====
const isNew = d => (new Date() - new Date(d)) < 7*24*60*60*1000;
const getPrix = p => (p.promo_active || p.flash_active) && p.promo_prix ? p.promo_prix : p.resale_price;
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
            alert("Pour installer l'app sur iPhone/iPad :\n\n1. Appuie sur le bouton Partager (carré avec une flèche) en bas de Safari\n2. Choisis \"Sur l'écran d'accueil\"\n3. Confirme");
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
function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - base64.length % 4) % 4);
    const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64Safe);
    return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function abonnerPushSiConnecte() {
    if (!currentUser) return;
    if (Notification.permission !== 'granted') { console.log('Push: permission =', Notification.permission); return; }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { alert('🔍 Diagnostic push : ce navigateur ne supporte pas les notifications push.'); return; }
    if (!CONFIG.VAPID_PUBLIC_KEY) { alert('🔍 Diagnostic push : clé VAPID manquante côté site.'); return; }
    try {
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY)
            });
        }
        const idToken = await window.firebaseAuth.currentUser.getIdToken();
        const resp = await fetch('/api/push-subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
            body: JSON.stringify({ subscription: sub.toJSON() })
        });
        if (!resp.ok) {
            const j = await resp.json().catch(()=>({}));
            alert('🔍 Diagnostic push : le serveur a refusé l\'abonnement — ' + (j.error || resp.status));
        }
    } catch (e) {
        console.error('Erreur abonnement push:', e);
        alert('🔍 Diagnostic push : ' + (e.message || e));
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
function closeOverlay(id) { const el=$(id); if(el){el.style.display='none'; document.body.style.overflow='';} }

// ===== DOM READY =====
document.addEventListener('DOMContentLoaded', async () => {
    setupPwa();

    // Vérifier page admin
    const path = window.location.pathname.replace(/\//g,'').replace('.html','');
    if (path === CONFIG.ADMIN_PATH) { afficherLoginAdmin(); return; }

    // Session
    try {
        const saved = localStorage.getItem('cmkt_user');
        if (saved) {
            currentUser = JSON.parse(saved); showUserUI();
            await chargerPanierServeur();
            ecouterPanierEnDirect();
        }
    } catch(e) { localStorage.removeItem('cmkt_user'); }

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
        if (url) { img.src = url; img.style.display = 'block'; }
        else { img.closest('.tuile-photo-wrap').style.display = 'none'; }
    });
}

// ===== PARAMETRES (modifiables par l'admin, sans toucher au code) =====
const CAT_SLUGS = { "Téléphonie":"telephonie", "Accessoires":"accessoires", "Électronique":"electronique", "Gaming":"gaming", "Réseau":"reseau", "Flash":"flash" };

async function chargerParametres() {
    try {
        const { data } = await db.from('parametres').select('*');
        if (!data) return;
        const slugToCat = Object.fromEntries(Object.entries(CAT_SLUGS).map(([k,v])=>[v,k]));
        data.forEach(({ cle, valeur }) => {
            if (!valeur) return;
            if (cle === 'agence_adresse') CONFIG.AGENCE_ADRESSE = valeur;
            else if (cle === 'agence_tel') CONFIG.AGENCE_TEL = valeur;
            else if (cle.startsWith('cat_img_')) {
                const slug = cle.replace('cat_img_', '');
                const cat = slugToCat[slug];
                if (cat) CONFIG.CATEGORY_IMAGES[cat] = valeur;
            }
        });
    } catch (e) { console.error('Erreur chargement paramètres:', e); }
}

// ===== TRADUCTION (FR/EN) =====
const I18N = {
    fr: {
        nav_accueil: '🏠 Accueil', nav_flash: '⚡ Ventes Flash', nav_promo: '🏷️ Promotions',
        nav_nouveautes: '🆕 Nouveautés', nav_meilleures: '⭐ Meilleures ventes',
        sep_categories: 'Catégories', sep_services: 'Services', sep_preferences: 'Préférences',
        cat_telephonie_ic: '📱 Téléphonie', cat_accessoires_ic: '🎧 Accessoires', cat_electronique_ic: '💻 Électronique',
        cat_reseau_ic: '📡 Réseau', cat_gaming_ic: '🎮 Gaming', cat_autre_ic: '📦 Autre',
        cat_telephonie: 'Téléphonie', cat_accessoires: 'Accessoires', cat_electronique: 'Électronique',
        cat_reseau: 'Réseau', cat_gaming: 'Gaming', cat_flash: 'Flash', cat_tous: 'Tous', cat_autre: 'Autre',
        nav_suivi: '🚚 Suivi de commande', nav_loc: '🏪 Localisation boutique', nav_contact: '📞 Nous contacter', nav_retour: '🔄 Politique de retour',
        pref_langue: '🌍 Langue', pref_sombre: '🌙 Mode sombre', pref_zone: '📍 Ma zone', pref_prixmax: '💰 Prix max (FCFA)',
        choisir: 'Choisir...', retrait_gratuit: '🏪 Retrait gratuit',
        rechercher_ph: '🔎 Rechercher un produit...', btn_connexion: '👤 Connexion',
        titre_flash: '⚡ Ventes Flash', titre_produits: '🛒 Nos Produits', chargement: 'Chargement...',
        footer_sub: 'Votre boutique tech à Douala', footer_copy: '© 2025 CAMERTECH MARKET — Douala, Cameroun',
        tab_connexion: 'Connexion', tab_inscription: 'Inscription', titre_connexion: '👤 Connexion',
        ph_email: 'Adresse email', ph_mdp: 'Mot de passe', btn_se_connecter: 'Se connecter',
        btn_mdp_oublie: 'Mot de passe oublié ?', ou: 'ou', btn_google: 'Continuer avec Google',
        titre_creer_compte: '📝 Créer un compte', ph_nom: 'Nom complet *', ph_email_req: 'Email *',
        ph_tel_livraison: 'Téléphone (9 chiffres) — pour la livraison *', ph_mdp_req: 'Mot de passe *',
        ph_confirmer_mdp: 'Confirmer mot de passe *', btn_creer_compte: 'Créer mon compte',
        titre_tel_manquant: '📞 Un dernier détail', txt_tel_manquant: 'Ton numéro de téléphone nous sert uniquement pour organiser la livraison de tes commandes.',
        ph_tel: 'Téléphone (9 chiffres)', btn_continuer: 'Continuer',
        titre_mdp_oublie: '🔑 Mot de passe oublié', txt_mdp_oublie: 'Entre ton email, on t\'envoie un lien pour choisir un nouveau mot de passe.',
        titre_panier: '🛒 Mon Panier', label_zone: '📍 Zone de livraison', choisir_zone: '-- Choisir votre zone --',
        ph_note: 'Note pour la commande (optionnel)...', btn_payer: '💳 Payer maintenant (Mobile Money)',
        btn_reserver: '📋 Réserver (paiement à la livraison)',
        txt_accepte_politique: 'J\'ai lu et j\'accepte la', lien_politique: 'politique de confidentialité',
        err_politique_requise: '❌ Tu dois accepter la politique de confidentialité pour continuer'
    },
    en: {
        nav_accueil: '🏠 Home', nav_flash: '⚡ Flash Sales', nav_promo: '🏷️ Promotions',
        nav_nouveautes: '🆕 New Arrivals', nav_meilleures: '⭐ Best Sellers',
        sep_categories: 'Categories', sep_services: 'Services', sep_preferences: 'Preferences',
        cat_telephonie_ic: '📱 Phones', cat_accessoires_ic: '🎧 Accessories', cat_electronique_ic: '💻 Electronics',
        cat_reseau_ic: '📡 Network', cat_gaming_ic: '🎮 Gaming', cat_autre_ic: '📦 Other',
        cat_telephonie: 'Phones', cat_accessoires: 'Accessories', cat_electronique: 'Electronics',
        cat_reseau: 'Network', cat_gaming: 'Gaming', cat_flash: 'Flash', cat_tous: 'All', cat_autre: 'Other',
        nav_suivi: '🚚 Track Order', nav_loc: '🏪 Store Location', nav_contact: '📞 Contact Us', nav_retour: '🔄 Return Policy',
        pref_langue: '🌍 Language', pref_sombre: '🌙 Dark Mode', pref_zone: '📍 My Area', pref_prixmax: '💰 Max Price (FCFA)',
        choisir: 'Choose...', retrait_gratuit: '🏪 Free pickup',
        rechercher_ph: '🔎 Search a product...', btn_connexion: '👤 Login',
        titre_flash: '⚡ Flash Sales', titre_produits: '🛒 Our Products', chargement: 'Loading...',
        footer_sub: 'Your tech shop in Douala', footer_copy: '© 2025 CAMERTECH MARKET — Douala, Cameroon',
        tab_connexion: 'Login', tab_inscription: 'Sign up', titre_connexion: '👤 Login',
        ph_email: 'Email address', ph_mdp: 'Password', btn_se_connecter: 'Log in',
        btn_mdp_oublie: 'Forgot password?', ou: 'or', btn_google: 'Continue with Google',
        titre_creer_compte: '📝 Create an account', ph_nom: 'Full name *', ph_email_req: 'Email *',
        ph_tel_livraison: 'Phone (9 digits) — for delivery *', ph_mdp_req: 'Password *',
        ph_confirmer_mdp: 'Confirm password *', btn_creer_compte: 'Create my account',
        titre_tel_manquant: '📞 One last detail', txt_tel_manquant: 'Your phone number is only used to organize delivery of your orders.',
        ph_tel: 'Phone (9 digits)', btn_continuer: 'Continue',
        titre_mdp_oublie: '🔑 Forgot password', txt_mdp_oublie: 'Enter your email, we\'ll send you a link to choose a new password.',
        titre_panier: '🛒 My Cart', label_zone: '📍 Delivery area', choisir_zone: '-- Choose your area --',
        ph_note: 'Note for the order (optional)...', btn_payer: '💳 Pay now (Mobile Money)',
        btn_reserver: '📋 Reserve (pay on pickup/delivery)',
        txt_accepte_politique: 'I have read and accept the', lien_politique: 'privacy policy',
        err_politique_requise: '❌ You must accept the privacy policy to continue'
    }
};

let currentLang = localStorage.getItem('cmkt_lang') || 'fr';
let translatedProductsCache = {}; // { productId: { name, description } } — en anglais uniquement

function appliquerTraductionUI(lang) {
    const dict = I18N[lang];
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        if (dict[key] !== undefined) el.textContent = dict[key];
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

    $('sl-accueil').onclick = () => { closeSidebar(); window.scrollTo({top:0,behavior:'smooth'}); };
    $('sl-flash').onclick = () => { closeSidebar(); filtrerFlash(); };
    $('sl-promo').onclick = () => { closeSidebar(); renderProducts(allProducts.filter(p=>p.promo_active)); };
    $('sl-nouveautes').onclick = () => { closeSidebar(); renderProducts(allProducts.filter(p=>isNew(p.created_at))); };
    $('sl-meilleures').onclick = () => { closeSidebar(); afficherMeilleuresVentes(); };
    $('sl-tel').onclick = () => { closeSidebar(); filtrerCat('Téléphonie'); };
    $('sl-acc').onclick = () => { closeSidebar(); filtrerCat('Accessoires'); };
    $('sl-elec').onclick = () => { closeSidebar(); filtrerCat('Électronique'); };
    $('sl-res').onclick = () => { closeSidebar(); filtrerCat('Réseau'); };
    $('sl-gam').onclick = () => { closeSidebar(); filtrerCat('Gaming'); };
    $('sl-suivi').onclick = () => { closeSidebar(); openOverlay('suivi-overlay'); };
    $('sl-loc').onclick = () => { closeSidebar(); openOverlay('loc-overlay'); };
    $('sl-retour').onclick = () => { closeSidebar(); openOverlay('retour-overlay'); };

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
        await chargerPanierServeur();
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
            await chargerPanierServeur();
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

function traduireErreurFirebase(code) {
    const map = {
        'auth/invalid-email': 'Adresse email invalide',
        'auth/user-not-found': 'Aucun compte avec cet email',
        'auth/wrong-password': 'Mot de passe incorrect',
        'auth/invalid-credential': 'Email ou mot de passe incorrect',
        'auth/email-already-in-use': 'Un compte existe déjà avec cet email',
        'auth/weak-password': 'Mot de passe trop court (6 min)',
        'auth/too-many-requests': 'Trop de tentatives, réessaie plus tard',
        'auth/popup-closed-by-user': 'Fenêtre Google fermée avant la fin'
    };
    return map[code] || 'Une erreur est survenue, réessaie';
}

function setupAuth() {
    $('btn-auth-show').onclick = () => openOverlay('auth-overlay');
    $('auth-close').onclick = () => closeOverlay('auth-overlay');
    $('auth-overlay').onclick = e => { if(e.target===$('auth-overlay')) closeOverlay('auth-overlay'); };

    $('lien-politique-reg').onclick = e => { e.preventDefault(); openOverlay('politique-overlay'); };
    $('lien-politique-tel').onclick = e => { e.preventDefault(); openOverlay('politique-overlay'); };

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
        try {
            const cred = await window.fbSignInWithEmail(window.firebaseAuth, email, mdp);
            const r = await creerOuChargerProfil(cred.user);
            if (r.ok) { closeOverlay('auth-overlay'); renderProducts(allProducts); }
            else if (!r.pending) { err.textContent = '❌ Profil introuvable : ' + (r.error?.message || 'contacte le support'); }
        } catch (e) {
            err.textContent = '❌ ' + traduireErreurFirebase(e.code);
        }
        $('btn-login').textContent = 'Se connecter';
    };

    $('btn-google-login').onclick = async () => {
        const err = $('login-err');
        err.textContent = '';
        try {
            const cred = await window.fbSignInWithPopup(window.firebaseAuth, window.googleProvider);
            const r = await creerOuChargerProfil(cred.user);
            if (r.ok) { closeOverlay('auth-overlay'); renderProducts(allProducts); }
            else if (!r.pending) { err.textContent = '❌ ' + (r.error?.message || r.error || 'Erreur, réessaie'); }
        } catch (e) {
            err.textContent = '❌ ' + traduireErreurFirebase(e.code);
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
            if (r.ok) { closeOverlay('auth-overlay'); renderProducts(allProducts); }
            else if (!r.pending) { err.textContent = '❌ ' + (r.error?.message || r.error || 'Erreur, réessaie'); }
        } catch (e) {
            err.textContent = '❌ ' + traduireErreurFirebase(e.code);
        }
    };

    $('btn-tel-manquant-confirmer').onclick = async () => {
        const tel = $('tel-manquant-input').value.trim();
        const err = $('tel-manquant-err');
        if (tel.length !== 9) { err.textContent = '❌ Numéro invalide (9 chiffres)'; return; }
        if (!$('tel-manquant-politique').checked) { err.textContent = I18N[currentLang].err_politique_requise; return; }
        const r = await creerOuChargerProfil(pendingFbUser, { telephone: tel, politiqueAcceptee: true });
        if (r.ok) { closeOverlay('tel-manquant-overlay'); closeOverlay('auth-overlay'); renderProducts(allProducts); }
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
            if (r.ok) { closeOverlay('auth-overlay'); }
            else { err.textContent = '❌ Compte créé mais profil non enregistré : ' + (r.error?.message || 'contacte le support'); }
        } catch (e) {
            $('btn-register').textContent = 'Créer mon compte';
            err.textContent = '❌ ' + traduireErreurFirebase(e.code);
        }
    };

    $('btn-logout').onclick = () => {
        window.fbSignOut(window.firebaseAuth).catch(()=>{});
        arreterEcoutePanier();
        currentUser = null;
        localStorage.removeItem('cmkt_user');
        $('user-zone').style.display = 'none';
        $('user-menu').style.display = 'none';
        $('btn-auth-show').style.display = '';
        panier = []; updatePanierBtn();
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
        <button onclick="this.closest('.modal-overlay').remove();afficherFavoris()" style="width:100%;margin-top:18px;background:var(--card);border:1.5px solid var(--border);color:var(--text);padding:12px;border-radius:var(--radius-pill);font-weight:600;cursor:pointer;font-family:var(--font-body)">🤍 Voir mes favoris</button>
    </div>`;
    document.body.appendChild(el);
}

// ===== FAVORIS =====
async function chargerFavoris() {
    if (!currentUser) return;
    const { data } = await db.from('favoris').select('product_id').eq('utilisateur_id', currentUser.id);
    favorisIds = new Set((data||[]).map(f => f.product_id));
    if (allProducts.length) renderProducts(allProducts);
}

window.toggleFavori = async (productId, btn) => {
    if (!currentUser) { openOverlay('auth-overlay'); return; }
    const estFavori = favorisIds.has(productId);
    if (estFavori) {
        favorisIds.delete(productId);
        await db.from('favoris').delete().eq('utilisateur_id', currentUser.id).eq('product_id', productId);
    } else {
        favorisIds.add(productId);
        await db.from('favoris').insert([{ utilisateur_id: currentUser.id, product_id: productId }]);
    }
    if (btn) { btn.textContent = estFavori ? '🤍' : '❤️'; btn.classList.toggle('active', !estFavori); }
};

function afficherFavoris() {
    const favs = allProducts.filter(p => favorisIds.has(p.id));
    currentCat = 'tous';
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
        err.textContent = '✅ Email envoyé à ' + email + ' — clique sur le lien pour choisir un nouveau mot de passe.';
    } catch (e) {
        err.textContent = '❌ ' + traduireErreurFirebase(e.code);
    }
    $('btn-reset-envoyer').textContent = 'Envoyer le lien'; $('btn-reset-envoyer').disabled = false;
}

// Traite le retour du lien de réinitialisation (arrivée sur notre propre domaine avec ?oobCode=...)
let resetOobCode = null;
async function verifierLienResetDansURL() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') !== 'resetPassword' || !params.get('oobCode')) return;
    resetOobCode = params.get('oobCode');
    try {
        await window.fbVerifyPasswordResetCode(window.firebaseAuth, resetOobCode);
        openOverlay('confirm-reset-overlay');
    } catch (e) {
        alert('❌ Ce lien de réinitialisation est invalide ou expiré. Redemandez-en un.');
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
        alert('✅ Mot de passe changé ! Tu peux te connecter.');
        openOverlay('auth-overlay');
    } catch (e) {
        err.textContent = '❌ ' + traduireErreurFirebase(e.code);
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

    const msg = popupMsg?.message || '🎉 Bienvenue sur CAMERTECH MARKET !';
    const titreVitrine = popupMsg?.produits_ids?.length ? '🛍️ Sélection du moment' : '⚡ Ventes Flash';
    const flyerHtml = popupMsg?.image_url
        ? `<img src="${popupMsg.image_url}" alt="Offre spéciale CAMERTECH MARKET" ${popupMsg.lien ? `onclick="closePopup();window.open('${popupMsg.lien}','_blank')" style="cursor:pointer;` : 'style="'}width:100%;border-radius:12px;margin-bottom:14px;display:block">`
        : `<img src="logo.png" alt="Logo CAMERTECH MARKET" style="height:55px;width:55px;border-radius:50%;margin-bottom:12px">`;
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
        ${!popupMsg?.image_url ? `<h2 style="font-family:Poppins,sans-serif;color:var(--green);margin-bottom:8px">CAMERTECH MARKET</h2>` : ''}
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
                    <span class="slide-prix-actuel">${fmt(s.prix_actuel)} FCFA</span>
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
                <div class="slide-media"><div class="slide-halo"></div><img src="${s.image_url}" class="slide-product-img img-blurup" loading="lazy" onload="this.classList.add('loaded')" alt="${s.titre||'Promotion'}"></div>`;
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
    if (totalSlides > 1) slideTimer = setInterval(() => goSlide((slideIndex+1) % totalSlides), 3200);

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
            currentCat = btn.dataset.cat;
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
    currentCat = cat;
    document.querySelectorAll('.cat-pill').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));
    renderProducts(allProducts);
    $('produits').scrollIntoView({behavior:'smooth'});
}

// ===== RECHERCHE =====
function setupSearch() {
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '');
    $('search-bar').oninput = e => {
        const q = norm(e.target.value.trim());
        renderProducts(q ? allProducts.filter(p => norm(p.name).includes(q) || norm(p.description||'').includes(q) || norm(p.category).includes(q)) : allProducts);
    };

    // Recherche par photo : ouvre l'appareil photo (autorisation caméra
    // demandée par le navigateur/OS à ce moment précis, pas avant).
    $('btn-recherche-photo').onclick = () => $('input-recherche-photo').click();
    $('input-recherche-photo').onchange = async (e) => {
        const fichier = e.target.files?.[0];
        e.target.value = '';
        if (!fichier) return;
        const btn = $('btn-recherche-photo');
        btn.textContent = '⏳'; btn.disabled = true;
        try {
            const base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(fichier);
            });
            const resp = await fetch('/api/recherche-photo', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: base64, media_type: fichier.type })
            });
            const result = await resp.json();
            if (!resp.ok) { alert('❌ ' + (result.error || 'Recherche impossible, réessaie.')); return; }

            const motscles = (result.motscles || []).map(norm);
            let resultats = allProducts.filter(p => {
                const texte = norm(p.name) + norm(p.description||'') + norm(p.category);
                return motscles.some(m => texte.includes(m));
            });
            if (!resultats.length && result.category) {
                resultats = allProducts.filter(p => p.category === result.category);
            }
            if (!resultats.length) { alert('😕 Aucun produit similaire trouvé dans le catalogue.'); return; }

            $('search-bar').value = '';
            renderProducts(resultats);
            $('produits').scrollIntoView({behavior:'smooth'});
        } catch (err) {
            alert('❌ Erreur lors de la recherche par photo.');
        } finally {
            btn.textContent = '📷'; btn.disabled = false;
        }
    };
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
                "url": "https://camertechmarket.com/"
            }
        }
    }));
    injecterJsonLd('schema-catalogue', {
        "@context": "https://schema.org",
        "@type": "ItemList",
        "name": "Catalogue CAMERTECH MARKET",
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
            "url": "https://camertechmarket.com/",
            "seller": { "@type": "Organization", "name": "CAMERTECH MARKET" }
        }
    });
}

function renderProducts(products) {
    const grid = $('product-grid');
    const filtered = currentCat === 'tous' ? products : products.filter(p => p.category === currentCat);
    $('prod-count').textContent = filtered.length + (currentLang==='en' ? ' product(s)' : ' produit(s)');
    grid.innerHTML = '';
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
                ${p.image_url ? `<img src="${p.image_url}" alt="${txt.name}" class="card-img img-blurup" loading="lazy" onload="this.classList.add('loaded')">` : '<div class="card-img-ph">📦</div>'}
                ${p.quantity < 5 && p.quantity > 0 ? `<span class="badge badge-low">${currentLang==='en'?'Low stock':'Stock faible'}</span>` : ''}
                ${p.flash_active ? '<span class="badge badge-flash">⚡ FLASH</span>' : isNew(p.created_at) ? '<span class="badge badge-new">🆕</span>' : ''}
                ${p.promo_active && !p.flash_active ? '<span class="badge badge-promo">🔥 PROMO</span>' : ''}
                ${pct ? `<span class="badge badge-pct">${pct}</span>` : ''}
                <button class="btn-favori ${favorisIds.has(p.id)?'active':''}" data-id="${p.id}">${favorisIds.has(p.id)?'❤️':'🤍'}</button>
            </div>
            <div class="card-body">
                <div class="card-cat">${catLabel(p.category)}</div>
                <div class="card-name">${txt.name}</div>
                <div class="card-qty">${currentLang==='en'?'Qty':'Qté'} : ${p.quantity}</div>
                ${hasPromo ? `<div class="prix-barre-sm">${fmt(p.resale_price)} FCFA</div>` : ''}
                <div class="card-price ${hasPromo?'promo':''}">${fmt(prix)} FCFA</div>
                <button class="btn-acheter">${currentLang==='en'?'View details':'Voir détails'}</button>
                ${isAdmin ? `<div class="card-admin-btns">
                    <button class="btn-sm-edit" data-id="${p.id}">✏️</button>
                    <button class="btn-sm-del" data-id="${p.id}">🗑️</button>
                    <button class="btn-sm-flash" data-id="${p.id}" data-flash="${p.flash_active}">⚡</button>
                </div>` : ''}
            </div>`;
        card.querySelector('.btn-acheter').onclick = e => { e.stopPropagation(); openModal(p.id); };
        card.querySelector('.btn-favori').onclick = e => { e.stopPropagation(); toggleFavori(p.id, e.currentTarget); };
        card.onclick = () => openModal(p.id);
        if (isAdmin) {
            card.querySelector('.btn-sm-edit').onclick = e => { e.stopPropagation(); chargerEditAdmin(p.id); };
            card.querySelector('.btn-sm-del').onclick = e => { e.stopPropagation(); supprimerProduit(p.id); };
            card.querySelector('.btn-sm-flash').onclick = e => { e.stopPropagation(); toggleFlash(p.id, p.flash_active); };
        }
        grid.appendChild(card);
    });
}

// ===== FLASH =====
let flashInterval = null;
function filtrerFlash() {
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
            ${p.image_url ? `<img src="${p.image_url}" alt="${texteProduit(p).name}" class="card-img img-blurup" loading="lazy" onload="this.classList.add('loaded')">` : '<div class="card-img-ph">📦</div>'}
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
    const { data } = await db.from('reservations').select('items');
    const counts = {};
    (data||[]).forEach(r => (r.items||[]).forEach(i => { counts[i.name]=(counts[i.name]||0)+i.qty; }));
    const sorted = [...allProducts].sort((a,b) => (counts[b.name]||0)-(counts[a.name]||0));
    renderProducts(sorted);
    $('produits').scrollIntoView({behavior:'smooth'});
}

// ===== MODAL PRODUIT =====
async function openModal(productId) {
    const p = allProducts.find(x => x.id === productId);
    if (!p) return;
    modalProduct = p;
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
    const waMsg = encodeURIComponent(`Bonjour CAMERTECH MARKET, intéressé par : ${p.name} (${fmt(prix)} FCFA)`);
    $('prod-wa').href = `https://wa.me/${CONFIG.WA1}?text=${waMsg}`;
    if (currentUser) { $('prod-actions').style.display='flex'; $('prod-login-hint').style.display='none'; }
    else { $('prod-actions').style.display='none'; $('prod-login-hint').style.display='block'; }
    $('feedback-produit-zone').innerHTML = htmlFeedbackProduit(p.id, p.category);
    openOverlay('prod-overlay');
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
    else panier.push({ id:modalProduct.id, name:modalProduct.name, prix, qty, image_url:modalProduct.image_url });
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
    if (!currentUser) return;
    const p = allProducts.find(x=>x.id===id);
    if (!p) return;
    const ex = panier.find(x=>x.id===id);
    if (ex) ex.qty++;
    else panier.push({id:p.id, name:p.name, prix:getPrix(p), qty:1});
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
                <strong style="font-size:0.88rem">${a.nom_client}</strong>
                <span style="color:var(--text3);font-size:0.75rem">${new Date(a.created_at).toLocaleDateString('fr-FR')}</span>
            </div>
            <div style="color:#f4c430;font-size:0.9rem">${stars(a.note)}</div>
            ${a.commentaire?`<p style="color:var(--text2);font-size:0.85rem;margin-top:6px">${a.commentaire}</p>`:''}
            ${a.photo_url?`<img src="${a.photo_url}" alt="Photo jointe par ${a.nom_client}" style="width:75px;height:75px;object-fit:cover;border-radius:7px;margin-top:8px;cursor:pointer" onclick="window.open('${a.photo_url}','_blank')">`:''}
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
let panierChannel = null;
let syncPanierTimeout = null;
let dernierPanierEnvoye = null; // évite de se re-synchroniser soi-même via l'écho Realtime

// Sauvegarde le panier courant côté serveur (anti-rebond : regroupe les appels rapprochés
// pour ne pas spammer Supabase à chaque clic +/-).
function syncPanierServeur() {
    if (!currentUser) return;
    clearTimeout(syncPanierTimeout);
    syncPanierTimeout = setTimeout(async () => {
        const items = panier;
        dernierPanierEnvoye = JSON.stringify(items);
        try {
            await db.from('paniers').upsert({
                utilisateur_id: currentUser.id,
                items,
                zone: userZone || null,
                frais_livraison: fraisLivraison || 0,
                updated_at: new Date().toISOString()
            }, { onConflict: 'utilisateur_id' });
        } catch (e) { console.error('Erreur synchro panier:', e); }
    }, 600);
}

// Charge le panier sauvegardé côté serveur à la connexion (ou à la restauration de session).
// Fusionne avec un panier local déjà présent au lieu de l'écraser, pour ne jamais faire
// perdre un article que le client vient d'ajouter avant même que la fusion arrive.
async function chargerPanierServeur() {
    if (!currentUser) return;
    try {
        const { data } = await db.from('paniers').select('*').eq('utilisateur_id', currentUser.id).single();
        if (!data) return;
        (data.items || []).forEach(item => {
            const ex = panier.find(x => x.id === item.id);
            if (ex) ex.qty = Math.max(ex.qty, item.qty);
            else panier.push(item);
        });
        if (!userZone && data.zone) userZone = data.zone;
        if (!fraisLivraison && data.frais_livraison) fraisLivraison = data.frais_livraison;
        updatePanierBtn();
        if ($('zone-select') && userZone) { $('zone-select').value = userZone; updateLivraison(); }
    } catch (e) { /* pas encore de panier serveur pour ce compte : normal */ }
}

// Écoute en direct les changements faits depuis un AUTRE appareil connecté au même compte
// (ex : le client ajoute un article sur PC pendant que son téléphone est ouvert sur le site).
function ecouterPanierEnDirect() {
    if (!currentUser || panierChannel) return;
    panierChannel = db.channel('panier-' + currentUser.id)
        .on('postgres_changes', {
            event: '*', schema: 'public', table: 'paniers',
            filter: 'utilisateur_id=eq.' + currentUser.id
        }, payload => {
            const nouveau = payload.new;
            if (!nouveau) return;
            if (dernierPanierEnvoye === JSON.stringify(nouveau.items)) return; // c'est notre propre écho
            panier = nouveau.items || [];
            userZone = nouveau.zone || userZone;
            fraisLivraison = nouveau.frais_livraison || 0;
            updatePanierBtn();
            if ($('zone-select')) $('zone-select').value = userZone || '';
            if ($('panier-overlay') && $('panier-overlay').style.display === 'flex') {
                panier.length ? renderPanier() : openPanier();
            }
        })
        .subscribe();
}

// Coupe l'écoute en direct (à la déconnexion, pour ne pas laisser un canal ouvert inutilement).
function arreterEcoutePanier() {
    if (panierChannel) { db.removeChannel(panierChannel); panierChannel = null; }
}

function setupPanier() {
    $('panier-btn').onclick = openPanier;
    $('panier-close').onclick = () => closeOverlay('panier-overlay');
    $('panier-overlay').onclick = e => { if(e.target===$('panier-overlay')) closeOverlay('panier-overlay'); };
    $('zone-select').onchange = updateLivraison;
    $('btn-payer').onclick = initierPaiement;
    $('btn-reserver').onclick = reserverSansPaiement;
    $('btn-copier').onclick = () => {
        navigator.clipboard.writeText($('code-display').textContent).then(() => {
            $('btn-copier').textContent='✅ Copié !';
            setTimeout(()=>$('btn-copier').textContent='📋 Copier le code',2000);
        });
    };
    $('btn-fermer-code').onclick = () => { closeOverlay('code-overlay'); panier=[]; updatePanierBtn(); syncPanierServeur(); };
    $('btn-copier-success').onclick = () => {
        navigator.clipboard.writeText($('success-code-display').textContent).then(() => {
            $('btn-copier-success').textContent='✅ Copié !';
            setTimeout(()=>$('btn-copier-success').textContent='📋 Copier le code',2000);
        });
    };
    $('btn-fermer-success').onclick = () => { closeOverlay('success-overlay'); panier=[]; updatePanierBtn(); syncPanierServeur(); };

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
    if (!currentUser) { alert('Connecte-toi pour réserver ta commande.'); return; }
    if (!panier.length) { alert('Ton panier est vide.'); return; }
    const btn = $('btn-reserver');
    btn.disabled = true; btn.textContent = 'Réservation en cours...';
    try {
        const total = panier.reduce((s,p)=>s+p.prix*p.qty,0); // sans frais de livraison
        const code = 'CMT-'+Math.random().toString(36).substring(2,5).toUpperCase()+'-'+Date.now().toString().slice(-4);
        await db.from('reservations').insert([{
            utilisateur_id: currentUser.id, nom_client: currentUser.nom, telephone: currentUser.telephone,
            code, items: panier.map(p=>({name:p.name,qty:p.qty,prix:p.prix})),
            total, statut: 'reservee', zone_livraison: null, frais_livraison: 0
        }]);
        $('reservation-code-display').textContent = code;
        closeOverlay('panier-overlay');
        openOverlay('reservation-overlay');
    } catch (e) {
        alert('❌ Erreur lors de la réservation. Réessaie.');
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

function renderPanier() {
    const items = $('panier-items');
    items.innerHTML='';
    let sousTotal=0;
    panier.forEach((item,i)=>{
        const st=item.prix*item.qty; sousTotal+=st;
        const d=document.createElement('div');
        d.className='panier-item';
        d.innerHTML=`<div class="panier-item-info"><strong>${item.name}</strong><span>${fmt(item.prix)} FCFA × ${item.qty}</span></div>
            <div class="panier-item-price">${fmt(st)} FCFA</div>
            <button class="btn-rm" data-idx="${i}">✕</button>`;
        d.querySelector('.btn-rm').onclick = e => { panier.splice(parseInt(e.target.dataset.idx),1); updatePanierBtn(); syncPanierServeur(); openPanier(); };
        items.appendChild(d);
    });
    updateTotaux(sousTotal);
}

function updateTotaux(sousTotal) {
    const total = sousTotal + fraisLivraison;
    $('panier-totaux').innerHTML=`<div class="totaux-box">
        <div class="total-ligne"><span>Sous-total</span><span>${fmt(sousTotal)} FCFA</span></div>
        <div class="total-ligne"><span>Livraison</span><span>${fraisLivraison>0?fmt(fraisLivraison)+' FCFA':'—'}</span></div>
        <div class="total-final"><span>Total</span><span>${fmt(total)} FCFA</span></div>
    </div>`;
}

function updateLivraison() {
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
    if(panier.length) renderPanier();
    syncPanierServeur();
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

function initierPaiement() {
    if (!currentUser) { alert('Connectez-vous pour payer.'); return; }
    if (!userZone) { alert('Choisissez votre zone de livraison.'); return; }
    const total = panier.reduce((s,p)=>s+p.prix*p.qty,0) + fraisLivraison;
    $('pay-amount').textContent = fmt(total) + ' FCFA';
    $('pay-status').textContent='';
    $('btn-pay-confirm').disabled=false;
    $('btn-pay-confirm').textContent='Payer maintenant';
    // Le formulaire numéro+opérateur n'a de sens qu'en mode H2H —
    // en mode widget, iKeePay gère ça lui-même dans sa fenêtre.
    const modeH2H = CONFIG.PAIEMENT_MODE === 'h2h';
    $('pay-methods-h2h').style.display = modeH2H ? 'flex' : 'none';
    $('pay-tel-wrap').style.display = modeH2H ? 'block' : 'none';
    if (modeH2H) $('pay-tel').value = currentUser.telephone || '';
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
        const total=panier.reduce((s,p)=>s+p.prix*p.qty,0)+fraisLivraison;
        const code='CMT-'+Math.random().toString(36).substring(2,5).toUpperCase()+'-'+Date.now().toString().slice(-4);
        await db.from('reservations').insert([{
            utilisateur_id:currentUser.id, nom_client:currentUser.nom, telephone:currentUser.telephone,
            code, items:panier.map(p=>({name:p.name,qty:p.qty,prix:p.prix})),
            total, zone_livraison:userZone, frais_livraison:fraisLivraison, statut:'paiement_en_cours',
            note:$('note-cmd').value||null
        }]);
        sessionStorage.setItem('cmkt_panier_'+code, JSON.stringify({ items: panier, total, zone: userZone, frais: fraisLivraison }));

        if (modeH2H) {
            // Mode H2H : notre serveur relit le vrai montant et déclenche
            // directement la demande de paiement MTN/Orange (prompt USSD).
            const resp = await fetch(CONFIG.API.PAIEMENT_H2H, {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({ reference: code, telephone: tel, operateur: selectedOp })
            });
            const result = await resp.json();
            if (!result.success) throw new Error(result.error||'Échec paiement');
            if (result.payment_link) {
                status.textContent='✅ Redirection...';
                setTimeout(() => { window.location.href = result.payment_link; }, 500);
                return;
            }
            status.style.color='var(--success)'; status.textContent='📲 Vérifie ton téléphone et valide la demande de paiement...';
            btn.disabled=true; btn.textContent='En attente de confirmation...';
            await attendreConfirmationCommande(code);
        } else {
            // Mode widget : le serveur relit le vrai montant de la commande
            // qu'on vient de créer (jamais celui calculé ici) avant de nous
            // donner le feu vert.
            const resp = await fetch(CONFIG.API.PREPARER_PAIEMENT, {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({ reference: code })
            });
            const result = await resp.json();
            if (!result.success) throw new Error(result.error||'Échec paiement');
            status.textContent=''; btn.disabled=false; btn.textContent='Payer maintenant';
            ouvrirWidgetIkeepay(result, code);
        }
    } catch(e) {
        status.style.color='var(--danger)'; status.textContent='❌ '+(e.message||'Erreur. Réessayez.');
        btn.disabled=false; btn.textContent='Payer maintenant';
    }
}

// Ouvre le widget iKeePay en overlay (iframe intégrée, aucune redirection externe)
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

    const onMessage = async (event) => {
        if (event.data === 'ikeepay-close') {
            fermerWidgetIkeepay();
        }
        if (event.data === 'ikeepay-success') {
            window.removeEventListener('message', onMessage);
            fermerWidgetIkeepay();
            await attendreConfirmationCommande(code);
        }
    };
    window.addEventListener('message', onMessage);
}

// Après le signal "succès" du widget, on attend la confirmation réelle du
// webhook côté serveur (jamais fait confiance au seul message de l'iframe,
// qui ne prouve rien côté serveur) avant d'afficher la page de succès.
async function attendreConfirmationCommande(code, tentative = 0) {
    const { data: resa } = await db.from('reservations').select('*').eq('code', code).single();
    if (resa?.statut === 'valide') {
        afficherSuccesDepuisResa(resa);
        return;
    }
    if (resa?.statut === 'paiement_echoue') {
        alert('❌ Le paiement a échoué ou a été annulé. Tu peux réessayer depuis ton panier.');
        return;
    }
    if (tentative >= 8) {
        alert('⏳ Paiement en cours de confirmation. Ta commande sera validée automatiquement dans un instant — vérifie dans "Mes commandes".');
        return;
    }
    setTimeout(() => attendreConfirmationCommande(code, tentative + 1), 2000);
}

// (ancienne gestion du retour de redirection GeniusPay supprimée — le widget
// iKeePay reste sur la page, la confirmation passe par attendreConfirmationCommande())

// Affiche la page de succès à partir d'une commande déjà enregistrée en base
// (utilisé au retour de paiement, quand le panier en mémoire a été perdu par la redirection)
function afficherSuccesDepuisResa(resa) {
    const sauvegarde = sessionStorage.getItem('cmkt_panier_'+resa.code);
    if (sauvegarde) {
        const d = JSON.parse(sauvegarde);
        panier = d.items; userZone = d.zone; fraisLivraison = d.frais;
        sessionStorage.removeItem('cmkt_panier_'+resa.code);
    } else {
        panier = (resa.items||[]).map(i => ({ name:i.name, qty:i.qty, prix:i.prix }));
        userZone = resa.zone_livraison; fraisLivraison = resa.frais_livraison || 0;
    }
    afficherSucces(resa.code, resa.total);
    panier = []; updatePanierBtn(); syncPanierServeur();
}

async function reserverSansPaiement() {
    if (!currentUser) { alert('Connectez-vous pour réserver.'); return; }
    if (!userZone) { alert('Choisissez votre zone de livraison.'); return; }
    const total=panier.reduce((s,p)=>s+p.prix*p.qty,0)+fraisLivraison;
    const code='CMT-'+Math.random().toString(36).substring(2,5).toUpperCase()+'-'+Date.now().toString().slice(-4);
    await db.from('reservations').insert([{
        utilisateur_id:currentUser.id, nom_client:currentUser.nom, telephone:currentUser.telephone,
        code, items:panier.map(p=>({name:p.name,qty:p.qty,prix:p.prix})),
        total, zone_livraison:userZone, frais_livraison:fraisLivraison, statut:'en attente',
        note:$('note-cmd').value||null
    }]);
    closeOverlay('panier-overlay');
    afficherCode(code,total);
    const waMsg=encodeURIComponent(`🛒 CAMERTECH MARKET\n\n👤 ${currentUser.nom}\n📞 ${currentUser.telephone}\n📍 Zone: ${userZone}\n🔑 Code: ${code}\n\n${panier.map(p=>`• ${p.name} ×${p.qty} = ${fmt(p.prix*p.qty)} F`).join('\n')}\n\n💰 TOTAL: ${fmt(total)} FCFA`);
    setTimeout(()=>window.open(`https://wa.me/${CONFIG.WA1}?text=${waMsg}`,'_blank'),500);
    panier=[]; updatePanierBtn(); syncPanierServeur();
}

function afficherCode(code, total) {
    $('code-display').textContent = code;
    let html=panier.map(p=>`<div class="recap-ligne"><span>${p.name} ×${p.qty}</span><span>${fmt(p.prix*p.qty)} F</span></div>`).join('');
    if(fraisLivraison>0) html+=`<div class="recap-ligne"><span>🚚 Livraison (${userZone})</span><span>${fmt(fraisLivraison)} F</span></div>`;
    html+=`<div class="recap-total"><span>Total</span><span>${fmt(total)} FCFA</span></div>`;
    $('code-recap').innerHTML=html;
    closeOverlay('panier-overlay');
    openOverlay('code-overlay');
}

// Page de succès affichée après confirmation d'un paiement (mobile money via iKeePay)
function afficherSucces(code, total) {
    $('success-code-display').textContent = code;
    let html=panier.map(p=>`<div class="recap-ligne"><span>${p.name} ×${p.qty}</span><span>${fmt(p.prix*p.qty)} F</span></div>`).join('');
    if(fraisLivraison>0) html+=`<div class="recap-ligne"><span>🚚 Livraison (${userZone})</span><span>${fmt(fraisLivraison)} F</span></div>`;
    html+=`<div class="recap-total"><span>Total</span><span>${fmt(total)} FCFA</span></div>`;
    $('success-recap').innerHTML = html;
    $('success-agence-msg').textContent = `Veuillez vous présenter à notre agence (${CONFIG.AGENCE_ADRESSE}) pour le retrait, ou contactez-nous au ${CONFIG.AGENCE_TEL.replace('237','')} pour organiser une expédition par agence de voyage si nécessaire.`;
    $('success-wa').href = `https://wa.me/${CONFIG.AGENCE_TEL}?text=${encodeURIComponent('Bonjour, je viens de payer ma commande '+code+' sur CAMERTECH MARKET.')}`;
    closeOverlay('panier-overlay');
    openOverlay('success-overlay');
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
    const {data}=await db.from('reservations').select('*').eq('code',code).single();
    if(!data){res.innerHTML='<p style="color:var(--danger)">❌ Code introuvable : '+code+'</p>';return;}
    const statuts={'en attente':'⏳ En attente','valide':'✅ Validée','livre':'🚚 Livrée','annule':'❌ Annulée','paiement_en_cours':'💳 Paiement en cours'};
    res.innerHTML=`<div style="background:var(--bg);border-radius:10px;padding:14px;border:1px solid var(--border)">
        <div style="font-family:monospace;color:var(--green);font-weight:700;margin-bottom:6px">${data.code}</div>
        <div style="font-size:1.05rem;margin-bottom:6px">${statuts[data.statut]||data.statut}</div>
        <div style="color:var(--text3);font-size:0.82rem">📅 ${new Date(data.created_at).toLocaleString('fr-FR')}</div>
        <div style="color:var(--text3);font-size:0.82rem">📍 ${data.zone_livraison||'Non précisé'}</div>
        <div style="color:var(--green);font-weight:700;margin-top:8px">${fmt(data.total)} FCFA</div>
    </div>`;
}

async function chargerCommandes() {
    if(!currentUser)return;
    const {data}=await db.from('reservations').select('*').eq('utilisateur_id',currentUser.id).order('created_at',{ascending:false});
    window._mesCommandes = (data||[]).filter(r => !r.masquee_client);
    afficherMesCommandes(window._mesCommandes);
    openOverlay('cmds-overlay');
}

function afficherMesCommandes(liste) {
    const list=$('cmds-list');
    const septJours = 7*24*60*60*1000;
    list.innerHTML=!liste.length?'<p style="color:var(--text3);text-align:center;padding:20px">Aucune commande.</p>'
        :liste.map(r=>{
            const peutRetourner = r.statut==='livre' && (Date.now() - new Date(r.created_at).getTime()) < septJours;
            const estPaye = r.statut==='valide' || r.statut==='livre';
            return `<div style="background:var(--bg);border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;align-items:start">
                <div style="font-family:monospace;color:var(--green);font-weight:700">${r.code}</div>
                <button onclick="supprimerCommandeClient('${r.code}')" title="Retirer de mon historique" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:0.9rem;padding:0 2px">🗑️</button>
            </div>
            <div style="color:var(--text3);font-size:0.78rem;margin:4px 0">📅 ${new Date(r.created_at).toLocaleString('fr-FR')} • 📍 ${r.zone_livraison||'—'}</div>
            <span style="display:inline-block;padding:3px 12px;border-radius:10px;font-size:0.72rem;font-weight:700;background:${r.statut==='en attente'?'#fff8f0':estPaye?'#f0fff4':'#fff0f0'};color:${r.statut==='en attente'?'var(--orange)':estPaye?'var(--success)':'var(--danger)'}">${r.statut}</span>
            <div style="color:var(--text2);font-size:0.82rem;margin-top:6px">${r.items.map(i=>`${i.name} ×${i.qty}`).join(', ')}</div>
            <div style="color:var(--green);font-weight:700;margin-top:4px">${fmt(r.total)} FCFA</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
                <button onclick="telechargerFacture('${r.code}')" style="background:linear-gradient(135deg,var(--green),var(--green-light));color:white;border:none;padding:9px 16px;border-radius:var(--radius-pill);font-size:0.82rem;font-weight:700;cursor:pointer;font-family:var(--font-title);letter-spacing:0.3px;box-shadow:0 3px 10px rgba(14,124,74,0.28);transition:transform 0.15s var(--ease)">⬇️ Télécharger ${estPaye?'(Facture)':'(non payé)'}</button>
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
        const idToken = await window.firebaseAuth.currentUser.getIdToken();
        await fetch('/api/facture', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
            body: JSON.stringify({ code, masquer: true })
        });
        chargerCommandes();
    } catch (e) {
        alert('❌ Erreur');
    }
};

window.telechargerFacture = async (code) => {
    try {
        if (!window.firebaseAuth?.currentUser) { alert('❌ Session expirée, reconnecte-toi puis réessaie.'); return; }
        const idToken = await window.firebaseAuth.currentUser.getIdToken();
        const resp = await fetch(`/api/facture?code=${encodeURIComponent(code)}`, {
            headers: { 'Authorization': 'Bearer ' + idToken }
        });
        if (!resp.ok) { const j = await resp.json().catch(()=>({})); alert('❌ ' + (j.error || 'Impossible de télécharger la facture')); return; }
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
        alert('❌ Erreur lors du téléchargement : ' + (e.message || 'inconnue'));
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
        await db.from('retours').insert([{ reservation_id: retourReservationId, utilisateur_id: currentUser.id, code_commande: $('retour-code-affiche').textContent, motif }]);
        err.style.color='var(--success)'; err.textContent = '✅ Demande envoyée, on te recontacte rapidement.';
        setTimeout(() => closeOverlay('demande-retour-overlay'), 1500);
    } catch(e) { err.style.color='var(--danger)'; err.textContent = '❌ ' + e.message; }
}

// ===== LOGIN ADMIN =====
function afficherLoginAdmin() {
    document.body.innerHTML=`
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f6f4;padding:20px;font-family:Inter,sans-serif">
        <div style="background:white;border-radius:18px;padding:36px;max-width:380px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.1)">
            <img src="logo.png" alt="Logo CAMERTECH MARKET" style="height:70px;width:70px;border-radius:50%;margin-bottom:14px;border:3px solid #1a5c2a">
            <h1 style="color:#1a5c2a;font-family:Poppins,sans-serif;margin-bottom:4px;font-size:1.3rem">CAMERTECH MARKET</h1>
            <p style="color:#666;font-size:0.85rem;margin-bottom:24px">Espace Administrateur</p>
            <div id="step1">
                <input type="text" id="adm-id" placeholder="Identifiant admin" style="width:100%;background:#f4f6f4;border:1.5px solid #e8e8e8;padding:13px;color:#1a1a1a;border-radius:10px;margin-bottom:10px;font-size:0.95rem;font-family:Inter,sans-serif">
                <input type="password" id="adm-mdp" placeholder="Mot de passe" style="width:100%;background:#f4f6f4;border:1.5px solid #e8e8e8;padding:13px;color:#1a1a1a;border-radius:10px;margin-bottom:16px;font-size:0.95rem;font-family:Inter,sans-serif">
                <button onclick="adminStep1()" style="width:100%;background:#1a5c2a;color:white;border:none;padding:14px;border-radius:10px;font-weight:700;cursor:pointer;font-size:1rem;font-family:Poppins,sans-serif">Continuer →</button>
            </div>
            <div id="step2" style="display:none">
                <p style="color:#2dc653;font-size:0.88rem;margin-bottom:14px">✅ Code envoyé sur WhatsApp !</p>
                <input type="text" id="adm-code" placeholder="Code WhatsApp (4 chiffres)" style="width:100%;background:#f4f6f4;border:1.5px solid #e8e8e8;padding:13px;color:#1a1a1a;border-radius:10px;margin-bottom:16px;font-size:1.2rem;text-align:center;letter-spacing:6px;font-family:Inter,sans-serif">
                <button onclick="adminStep2()" style="width:100%;background:#1a5c2a;color:white;border:none;padding:14px;border-radius:10px;font-weight:700;cursor:pointer;font-size:1rem">Confirmer</button>
            </div>
            <p id="adm-err" style="color:#e63946;font-size:0.85rem;min-height:20px;margin-top:10px"></p>
        </div>
    </div>`;
}

let adminTicketTemp=null, adminTries=0;

window.adminStep1 = async () => {
    const id=document.getElementById('adm-id').value.trim();
    const mdp=document.getElementById('adm-mdp').value.trim();
    const err=document.getElementById('adm-err');
    const btn = document.querySelector('#step1 button');
    err.textContent = ''; if (btn) { btn.disabled = true; btn.textContent = 'Vérification...'; }
    try {
        const resp = await fetch('/api/admin-auth', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ step: 1, id, mdp })
        });
        const data = await resp.json();
        if (!resp.ok) {
            adminTries++;
            err.textContent = `❌ ${data.error || 'Identifiant ou mot de passe incorrect'}` + (resp.status===401 ? ` (${adminTries}/3)` : '');
            if (adminTries>=3) { document.getElementById('step1').style.opacity='0.4'; document.getElementById('step1').style.pointerEvents='none'; err.textContent='🚫 Trop de tentatives.'; }
            return;
        }
        adminTicketTemp = data.ticket;
        const msg=encodeURIComponent(`🔐 CAMERTECH MARKET\nCode admin : ${data.code}\nValide 5 min.`);
        window.open(`https://wa.me/${data.wa}?text=${msg}`,'_blank');
        document.getElementById('step1').style.display='none';
        document.getElementById('step2').style.display='block';
    } catch (e) {
        err.textContent = '❌ Erreur réseau, réessaie';
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Continuer →'; }
    }
};

window.adminStep2 = async () => {
    const codeEl = document.getElementById('adm-code');
    const err = document.getElementById('adm-err');
    if (!codeEl) { console.error('Element adm-code introuvable'); return; }
    const code = codeEl.value.trim();
    if (!code) { err.textContent='❌ Entrez le code reçu'; return; }
    if (!adminTicketTemp) { err.textContent='❌ Session expirée. Cliquez sur Retour et recommencez.'; return; }
    const btn = document.querySelector('#step2 button');
    err.textContent = ''; if (btn) { btn.disabled = true; btn.textContent = 'Vérification...'; }
    try {
        const resp = await fetch('/api/admin-auth', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ step: 2, ticket: adminTicketTemp, code })
        });
        const data = await resp.json();
        if (!resp.ok) { err.textContent = `❌ ${data.error || 'Code incorrect'}`; return; }
        isAdmin = true;
        currentAdmin = { id: data.id, wa: data.wa };
        sessionStorage.setItem('cmkt_admin_token', data.token);
        sessionStorage.setItem('cmkt_admin_id', data.id);
        sessionStorage.setItem('cmkt_admin_wa', data.wa);
        afficherPanneauAdmin();
    } catch (e) {
        err.textContent = '❌ Erreur réseau, réessaie';
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Confirmer'; }
    }
};

// ===== PANNEAU ADMIN (simplifié mais complet) =====
function renderProduitsLignes(prods) {
    return (prods||[]).map(p=>`<tr style="border-bottom:1px solid #f8f8f8">
        <td style="padding:10px"><strong>${p.name}</strong></td>
        <td style="padding:10px;color:#888">${p.category}</td>
        <td style="padding:10px;font-weight:600;color:${p.quantity===0?'#e63946':p.quantity<5?'#ff6600':'#2dc653'}">${p.quantity}</td>
        <td style="padding:10px;color:#1a5c2a;font-weight:600">${fmt(p.resale_price)} F</td>
        <td style="padding:10px">${p.flash_active?'<span style="color:#e63946;font-weight:600">⚡Flash</span>':p.promo_active?'<span style="color:#ff6600;font-weight:600">🔥Promo</span>':'Normal'}</td>
        <td style="padding:10px"><div style="display:flex;gap:5px">
            <button onclick="chargerEditProduit('${p.id}')" style="background:#f0fff4;color:#1a5c2a;border:1px solid #b7f5c8;padding:5px 10px;border-radius:6px;font-size:0.78rem;cursor:pointer">✏️</button>
            <button onclick="supprimerProduit('${p.id}')" style="background:#fff0f0;color:#e63946;border:1px solid #fcc;padding:5px 10px;border-radius:6px;font-size:0.78rem;cursor:pointer">🗑️</button>
            <button onclick="toggleFlash('${p.id}',${p.flash_active})" style="background:#fff8f0;color:#ff6600;border:1px solid #fdd;padding:5px 10px;border-radius:6px;font-size:0.78rem;cursor:pointer">${p.flash_active?'❌Flash':'⚡Flash'}</button>
        </div></td>
    </tr>`).join('');
}

// Rafraîchit uniquement la liste des produits (sans reconstruire tout le panneau admin,
// donc sans jamais changer d'onglet ni casser l'état de la page).
async function rafraichirProduits() {
    try {
        const { data } = await db.from('products').select('*').order('created_at',{ascending:false});
        window._prods = data || [];
        const tbody = document.getElementById('prods-tbody');
        const count = document.getElementById('prods-count');
        if (tbody) tbody.innerHTML = renderProduitsLignes(window._prods);
        if (count) count.textContent = window._prods.length;
    } catch (e) { console.error('Erreur rafraîchissement produits:', e); }
}

// Appelle la route serveur admin-action (protégée par jeton admin) au lieu
// d'écrire directement dans Supabase depuis le navigateur avec la clé anon.
async function adminAction(ressource, action, { id, payload } = {}) {
    const resp = await fetch('/api/admin-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (sessionStorage.getItem('cmkt_admin_token') || '') },
        body: JSON.stringify({ ressource, action, id, payload })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Erreur admin');
    return data;
}

async function afficherPanneauAdmin() {
    let page = document.getElementById('admin-page');
    if (!page) {
        document.body.innerHTML = '<div id="admin-page" style="min-height:100vh;background:#f5f5f5"></div>';
        page = document.getElementById('admin-page');
    }
    page.style.display='block';
    page.innerHTML='<div style="text-align:center;padding:60px;color:#888;font-family:Inter,sans-serif">Chargement du panneau...</div>';

    const [{data:prods},usersResult,{data:reservations},{data:avisListe},{data:bannieres},{data:params},{data:retours},feedbackStats]=await Promise.all([
        db.from('products').select('*').order('created_at',{ascending:false}),
        adminAction('utilisateurs','list').catch(()=>({data:[]})),
        db.from('reservations').select('*').order('created_at',{ascending:false}),
        db.from('avis').select('*').eq('valide',false),
        db.from('bannières').select('*').eq('actif',true),
        db.from('parametres').select('*'),
        db.from('retours').select('*').order('created_at',{ascending:false}),
        adminAction('feedback_produits','stats').catch(()=>({total:0,parChoix:{},parProduit:{},recents:[]}))
    ]);
    const users = usersResult.data;
    const paramMap = Object.fromEntries((params||[]).map(p=>[p.cle,p.valeur]));

    // Revenu réel : uniquement les commandes dont le paiement est confirmé
    // (valide/livrée) — jamais celles encore en attente de paiement,
    // échouées ou annulées.
    const totalV=(reservations||[]).filter(r=>['valide','livre'].includes(r.statut)).reduce((s,r)=>s+parseFloat(r.total),0);
    const enAtt=(reservations||[]).filter(r=>r.statut==='en attente').length;
    const sfaible=(prods||[]).filter(p=>p.quantity<5&&p.quantity>0);
    const szero=(prods||[]).filter(p=>p.quantity===0);
    // N'apparaît dans "Commandes" que ce qui a réellement été payé —
    // jamais une tentative de paiement en cours ou échouée.
    const commandesPayees = (reservations||[]).filter(r => !['paiement_en_cours','paiement_echoue'].includes(r.statut));
    window._prods=prods||[]; window._res=commandesPayees;

    page.innerHTML=`
    <div style="font-family:Inter,sans-serif">
        <div style="background:#1a5c2a;color:white;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;position:sticky;top:0;z-index:10">
            <h1 style="font-family:Poppins,sans-serif;font-size:1.1rem;margin:0">⚙️ CAMERTECH MARKET Admin</h1>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button onclick="showTab('tab-dash')" class="adm-tab active" id="tb-dash">📊 Dashboard</button>
                <button onclick="showTab('tab-prods')" class="adm-tab" id="tb-prods">📦 Produits</button>
                <button onclick="showTab('tab-cmds')" class="adm-tab" id="tb-cmds">🧾 Commandes</button>
                <button onclick="showTab('tab-users')" class="adm-tab" id="tb-users">👥 Clients</button>
                <button onclick="showTab('tab-avis')" class="adm-tab" id="tb-avis">⭐ Avis(${(avisListe||[]).length})</button>
                <button onclick="showTab('tab-mktg')" class="adm-tab" id="tb-mktg">📢 Marketing</button>
                <button onclick="showTab('tab-param')" class="adm-tab" id="tb-param">⚙️ Paramètres</button>
                <button onclick="showTab('tab-retours')" class="adm-tab" id="tb-retours">🔄 Retours</button>
                <button onclick="window.location.href='/'" class="adm-tab">🏪 Site</button>
            </div>
        </div>
        <div style="max-width:1200px;margin:0 auto;padding:20px 16px">

        <!-- DASHBOARD -->
        <div id="tab-dash">
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px">
                ${[['💰','Total ventes',fmt(totalV)+' F'],['🧾','Commandes',commandesPayees.length],['⏳','En attente',enAtt],['📦','Produits',(prods||[]).length],['👥','Clients',(users||[]).length],['⚠️','Alertes stock',sfaible.length+szero.length]].map(([ico,lbl,val])=>`
                <div style="background:white;border:1px solid #e8e8e8;border-radius:12px;padding:16px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.06)">
                    <div style="font-size:1.7rem;margin-bottom:6px">${ico}</div>
                    <div style="font-size:1.2rem;font-weight:800;color:#1a5c2a;font-family:Poppins,sans-serif">${val}</div>
                    <div style="color:#888;font-size:0.75rem;margin-top:2px">${lbl}</div>
                </div>`).join('')}
            </div>
            ${(sfaible.length+szero.length)>0?`<div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:20px;margin-bottom:16px">
                <h2 style="font-size:1rem;margin-bottom:12px">⚠️ Alertes Stock</h2>
                ${szero.map(p=>`<div style="display:flex;justify-content:space-between;background:#fff0f0;border:1px solid #fcc;border-radius:8px;padding:10px 14px;margin-bottom:8px"><span>🔴 <strong>${p.name}</strong></span><span style="color:#e63946">ÉPUISÉ</span></div>`).join('')}
                ${sfaible.map(p=>`<div style="display:flex;justify-content:space-between;background:#fff8f0;border:1px solid #fdd;border-radius:8px;padding:10px 14px;margin-bottom:8px"><span>🟡 <strong>${p.name}</strong></span><span style="color:#ff6600">${p.quantity} restant(s)</span></div>`).join('')}
            </div>`:''}
        </div>

        <!-- PRODUITS -->
        <div id="tab-prods" style="display:none">
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px;margin-bottom:16px">
                <h2 id="prod-form-title" style="font-size:1rem;margin-bottom:16px">➕ Ajouter un Produit</h2>
                <div style="display:flex;flex-direction:column;gap:10px">
                    <input type="text" id="p-name" placeholder="Nom du produit *" class="adm-input">
                    <textarea id="p-desc" placeholder="Description" rows="2" class="adm-input"></textarea>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                        <select id="p-cat" class="adm-input"><option value="Téléphonie">📱 Téléphonie</option><option value="Accessoires">🎧 Accessoires</option><option value="Électronique">💻 Électronique</option><option value="Réseau">📡 Réseau</option><option value="Gaming">🎮 Gaming</option><option value="Autre">📦 Autre</option></select>
                        <input type="number" id="p-qty" placeholder="Quantité *" class="adm-input">
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                        <input type="number" id="p-achat" placeholder="Prix achat (FCFA) *" class="adm-input">
                        <input type="number" id="p-vente" placeholder="Prix vente public (FCFA) *" class="adm-input">
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                        <input type="number" id="p-promo" placeholder="Prix promo (FCFA)" class="adm-input">
                        <label style="display:flex;align-items:center;gap:8px;color:#555;font-size:0.88rem"><input type="checkbox" id="p-promo-chk"> 🔥 Activer promo</label>
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
                        <input type="datetime-local" id="p-flash-fin" class="adm-input">
                        <label style="display:flex;align-items:center;gap:8px;color:#555;font-size:0.88rem"><input type="checkbox" id="p-flash-chk"> ⚡ Vente Flash</label>
                    </div>
                    <div id="p-img-dropzone" style="background:#f4f6f4;border:1.5px dashed #ddd;border-radius:8px;padding:14px;transition:background 0.2s" ondragover="handleDragOverImages(event)" ondragleave="handleDragLeaveImages(event)" ondrop="handleDropImages(event)">
                        <p style="font-size:0.82rem;color:#888;margin-bottom:8px">📷 Photo (optimisée automatiquement, haute qualité conservée) — glisse-dépose aussi possible ici</p>
                        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                            <label style="background:white;border:1px solid #ddd;padding:9px 14px;border-radius:7px;cursor:pointer;font-size:0.85rem">
                                ⬆️ Uploader<input type="file" id="p-img-file" accept="image/*" multiple style="display:none" onchange="previewAdminImg(this)">
                            </label>
                            <input type="url" id="p-img-url" placeholder="ou URL image" class="adm-input" style="flex:1;min-width:150px">
                            <button type="button" id="btn-ia-analyser" onclick="analyserProduitIA()" style="background:#eef4ff;border:1px solid #cfe0ff;color:#0055bb;padding:9px 14px;border-radius:7px;cursor:pointer;font-size:0.85rem;white-space:nowrap">🤖 Analyser avec l'IA</button>
                        </div>
                        <label style="display:flex;align-items:center;gap:8px;font-size:0.8rem;color:#666;margin-top:8px">
                            <input type="checkbox" id="ia-mode-lot"> Ce sont des <strong>produits différents</strong> (pas le même produit sous plusieurs angles) — l'IA créera une fiche par photo
                        </label>
                        <p id="ia-res" style="font-size:0.78rem;margin-top:6px;min-height:16px"></p>
                        <div id="adm-img-preview" style="display:none;margin-top:10px;position:relative;display:inline-block">
                            <img id="adm-img" src="" style="max-height:140px;border-radius:8px;max-width:100%">
                            <button onclick="resetAdminImg()" style="position:absolute;top:4px;right:4px;background:rgba(255,255,255,0.9);color:#e63946;border:none;border-radius:4px;padding:3px 7px;font-size:0.75rem;cursor:pointer">✕</button>
                        </div>
                        <div id="adm-img-extra" style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center"></div>
                    </div>
                    <div id="ia-lot-resultats" style="display:none;flex-direction:column;gap:10px"></div>
                    <div style="display:flex;gap:10px">
                        <button onclick="sauvegarderProduit()" style="flex:1;background:#1a5c2a;color:white;border:none;padding:12px;border-radius:9px;font-weight:700;cursor:pointer;font-size:0.95rem">Enregistrer</button>
                        <button id="btn-annuler-edit" onclick="annulerEdit()" style="display:none;background:#fff0f0;color:#e63946;border:1px solid #fcc;padding:12px 16px;border-radius:9px;font-weight:600;cursor:pointer">Annuler</button>
                    </div>
                    <p id="prod-msg" style="min-height:18px;font-size:0.82rem"></p>
                </div>
            </div>
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px">
                <h2 style="font-size:1rem;margin-bottom:14px">📦 Produits (<span id="prods-count">${(prods||[]).length}</span>)</h2>
                <div style="overflow-x:auto">
                    <table style="width:100%;border-collapse:collapse;font-size:0.82rem">
                        <thead><tr>${['Nom','Catégorie','Stock','Prix','Statut','Actions'].map(h=>`<th style="color:#888;font-weight:600;text-align:left;padding:8px 10px;border-bottom:2px solid #f0f0f0;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px">${h}</th>`).join('')}</tr></thead>
                        <tbody id="prods-tbody">${renderProduitsLignes(prods)}</tbody>
                    </table>
                </div>
            </div>
        </div>

        <!-- COMMANDES -->
        <div id="tab-cmds" style="display:none">
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px">
                <h2 style="font-size:1rem;margin-bottom:14px">🧾 Commandes</h2>
                <input type="text" id="cmd-search" placeholder="🔎 Rechercher code ou client..." oninput="filtrerCmdsAdmin(this.value)" style="width:100%;background:#f4f6f4;border:1.5px solid #e8e8e8;padding:10px 14px;color:#1a1a1a;border-radius:9px;font-size:0.88rem;margin-bottom:14px;font-family:Inter,sans-serif">
                <div id="cmds-admin-table">${renderCmdsAdmin(commandesPayees)}</div>
            </div>
        </div>

        <!-- CLIENTS -->
        <div id="tab-users" style="display:none">
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px">
                <h2 style="font-size:1rem;margin-bottom:14px">👥 Clients inscrits (${(users||[]).length})</h2>
                <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.82rem">
                    <thead><tr>${['Nom','Téléphone','Email','Inscrit le','Action'].map(h=>`<th style="color:#888;font-weight:600;text-align:left;padding:8px 10px;border-bottom:2px solid #f0f0f0;font-size:0.75rem">${h}</th>`).join('')}</tr></thead>
                    <tbody>${(users||[]).map(u=>`<tr style="border-bottom:1px solid #f8f8f8">
                        <td style="padding:10px"><strong>${u.nom}</strong></td>
                        <td style="padding:10px">📞 ${u.telephone}</td>
                        <td style="padding:10px;color:#888">${u.email||'—'}</td>
                        <td style="padding:10px;color:#888;font-size:0.78rem">${new Date(u.created_at).toLocaleDateString('fr-FR')}</td>
                        <td style="padding:10px"><button onclick="adminResetMdp('${u.id}','${u.nom.replace(/'/g,"\\'")}','${u.email||''}')" style="background:#fff8f0;color:#ff6600;border:1px solid #fdd;padding:5px 10px;border-radius:6px;font-size:0.75rem;cursor:pointer;margin-right:6px">🔑 Réinitialiser mdp</button><button onclick="adminSupprimerUtilisateur('${u.id}','${u.nom.replace(/'/g,"\\'")}')" style="background:#fff0f0;color:#e63946;border:1px solid #fcc;padding:5px 10px;border-radius:6px;font-size:0.75rem;cursor:pointer">🗑️ Supprimer</button></td>
                    </tr>`).join('')}</tbody>
                </table></div>
            </div>
        </div>

        <!-- AVIS -->
        <div id="tab-avis" style="display:none">
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px">
                <h2 style="font-size:1rem;margin-bottom:14px">⭐ Avis en attente</h2>
                ${!(avisListe||[]).length?'<p style="color:#888">Aucun avis en attente.</p>'
                :(avisListe||[]).map(a=>`<div style="background:#f8f8f8;border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid #eee">
                    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
                        <div><strong>${a.nom_client}</strong> — <span style="color:#f4c430">${'★'.repeat(a.note)}</span></div>
                        <div style="display:flex;gap:6px">
                            <button onclick="validerAvisAdmin('${a.id}')" style="background:#f0fff4;color:#2dc653;border:1px solid #b7f5c8;padding:6px 12px;border-radius:6px;font-size:0.8rem;cursor:pointer">✅ Valider</button>
                            <button onclick="supprimerAvisAdmin('${a.id}')" style="background:#fff0f0;color:#e63946;border:1px solid #fcc;padding:6px 12px;border-radius:6px;font-size:0.8rem;cursor:pointer">🗑️</button>
                        </div>
                    </div>
                    ${a.commentaire?`<p style="color:#555;font-size:0.85rem;margin-top:6px">${a.commentaire}</p>`:''}
                    ${a.photo_url?`<img src="${a.photo_url}" style="width:70px;height:70px;object-fit:cover;border-radius:6px;margin-top:8px">`:''}
                </div>`).join('')}
            </div>
        </div>

        <!-- MARKETING -->
        <div id="tab-mktg" style="display:none">
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px;margin-bottom:16px">
                <h2 style="font-size:1rem;margin-bottom:14px">📢 Publier un message</h2>
                <div style="display:flex;flex-direction:column;gap:10px">
                    <input type="text" id="mktg-msg" placeholder="Message..." class="adm-input">
                    <select id="mktg-type" class="adm-input">
                        <option value="banniere">📌 Bannière défilante</option>
                        <option value="popup">🔔 Popup à l'arrivée</option>
                        <option value="slider">🖼️ Slide pub (+ image URL)</option>
                    </select>
                    <div id="mktg-slider-extra" style="display:none;flex-direction:column;gap:8px">
                        <input type="text" id="mktg-titre" placeholder="Titre du slide" class="adm-input">
                        <input type="text" id="mktg-tag" placeholder="Tag (ex: 🔥 PROMO)" class="adm-input">
                        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                            <label style="background:white;border:1px solid #ddd;padding:9px 14px;border-radius:7px;cursor:pointer;font-size:0.85rem">
                                ⬆️ Uploader<input type="file" id="mktg-slider-file" accept="image/*" style="display:none" onchange="previewSliderImg(this)">
                            </label>
                            <input type="url" id="mktg-img-url" placeholder="ou URL image (idéalement PNG transparent)" class="adm-input" style="flex:1;min-width:150px">
                        </div>
                        <div id="mktg-slider-preview" style="display:none"><img id="mktg-slider-preview-img" style="max-height:100px;border-radius:8px"></div>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                            <input type="number" id="mktg-prix-actuel" placeholder="Prix actuel (FCFA)" class="adm-input">
                            <input type="number" id="mktg-prix-ancien" placeholder="Ancien prix (optionnel)" class="adm-input">
                        </div>
                        <input type="text" id="mktg-btn-txt" placeholder="Texte bouton" class="adm-input">
                        <select id="mktg-slide-produit" class="adm-input">
                            <option value="">Au clic : faire défiler vers les produits</option>
                            ${(prods||[]).map(p=>`<option value="${p.id}">${p.name}</option>`).join('')}
                        </select>
                    </div>
                    <div id="mktg-popup-extra" style="display:none;flex-direction:column;gap:10px">
                        <div style="background:#f4f6f4;border:1.5px dashed #ddd;border-radius:8px;padding:14px">
                            <p style="font-size:0.82rem;color:#888;margin-bottom:8px">🖼️ Flyer du popup (optionnel — ton visuel créé sur Canva, etc.)</p>
                            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                                <label style="background:white;border:1px solid #ddd;padding:9px 14px;border-radius:7px;cursor:pointer;font-size:0.85rem">
                                    ⬆️ Uploader<input type="file" id="mktg-popup-file" accept="image/*" style="display:none" onchange="previewPopupFlyer(this)">
                                </label>
                                <input type="url" id="mktg-popup-img" placeholder="ou URL image" class="adm-input" style="flex:1;min-width:150px">
                            </div>
                            <div id="mktg-popup-preview" style="display:none;margin-top:10px">
                                <img id="mktg-popup-preview-img" style="width:100%;max-height:140px;object-fit:cover;border-radius:8px">
                            </div>
                        </div>
                        <input type="url" id="mktg-popup-lien" placeholder="Lien au clic sur le flyer (optionnel)" class="adm-input">
                        <div style="background:#f4f6f4;border:1.5px solid #e8e8e8;border-radius:8px;padding:12px">
                            <p style="font-size:0.82rem;color:#888;margin-bottom:8px">🛍️ Produits à mettre en avant dans le popup (max 4 — sinon les ventes flash s'affichent automatiquement)</p>
                            <input type="text" id="mktg-prod-search" placeholder="Rechercher un produit..." class="adm-input" style="margin-bottom:8px" oninput="filtrerProduitsPopup()">
                            <div id="mktg-prod-liste" style="max-height:180px;overflow-y:auto;display:flex;flex-direction:column;gap:4px">
                                ${(prods||[]).map(p=>`<label class="mktg-prod-item" data-nom="${(p.name||'').toLowerCase()}" style="display:flex;align-items:center;gap:8px;padding:6px;border-radius:6px;font-size:0.82rem;cursor:pointer">
                                    <input type="checkbox" value="${p.id}" class="mktg-prod-chk"> ${p.image_url?`<img src="${p.image_url}" style="width:28px;height:28px;object-fit:cover;border-radius:4px">`:'📦'} ${p.name} <span style="color:#888;margin-left:auto">${fmt(getPrix(p))} F</span>
                                </label>`).join('')}
                            </div>
                        </div>
                    </div>
                    <button onclick="publierMessage()" style="background:#1a5c2a;color:white;border:none;padding:12px;border-radius:9px;font-weight:700;cursor:pointer">Publier</button>
                    <p id="mktg-res" style="min-height:18px;font-size:0.82rem"></p>
                </div>
            </div>
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px">
                <h2 style="font-size:1rem;margin-bottom:14px">Messages actifs</h2>
                <div id="mktg-liste">${(bannieres||[]).length?
                    (bannieres||[]).map(b=>`<div style="background:#f8f8f8;border-radius:8px;padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
                        <div style="display:flex;align-items:center;gap:10px">
                            ${b.image_url?`<img src="${b.image_url}" style="width:44px;height:44px;object-fit:cover;border-radius:6px">`:''}
                            <div><span style="background:${b.type==='popup'?'#0088ff':b.type==='slider'?'#ff6600':'#1a5c2a'};color:white;padding:2px 8px;border-radius:4px;font-size:0.72rem;font-weight:700">${b.type.toUpperCase()}</span><span style="margin-left:8px;font-size:0.88rem">${b.message}</span>${b.produits_ids?.length?`<span style="margin-left:8px;color:#888;font-size:0.72rem">🛍️ ${b.produits_ids.length} produit(s)</span>`:''}</div>
                        </div>
                        <button onclick="desactiverBanniere('${b.id}')" style="background:#fff0f0;color:#e63946;border:1px solid #fcc;padding:6px 12px;border-radius:6px;font-size:0.8rem;cursor:pointer">Désactiver</button>
                    </div>`).join(''):'<p style="color:#888">Aucun message actif.</p>'}
                </div>
            </div>
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px">
                <h2 style="font-size:1rem;margin-bottom:4px">📊 Retours des clients (fiche produit)</h2>
                <p style="font-size:0.8rem;color:#888;margin-bottom:14px">${feedbackStats.total || 0} retour(s) collecté(s) au total.</p>
                ${feedbackStats.total ? `
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px">
                    ${[
                        {id:'plus',label:'👍 Veulent en voir plus',color:'#0088ff'},
                        {id:'moins',label:'👎 Ne veulent plus voir',color:'#e63946'},
                        {id:'cher',label:'💸 Trop cher',color:'#ff6600'},
                        {id:'possede',label:'✅ Déjà acheté',color:'#2dc653'}
                    ].map(o=>`<div style="background:#f8f8f8;border-radius:8px;padding:12px;text-align:center">
                        <div style="font-size:1.4rem;font-weight:800;color:${o.color}">${feedbackStats.parChoix?.[o.id]||0}</div>
                        <div style="font-size:0.72rem;color:#888;margin-top:2px">${o.label}</div>
                    </div>`).join('')}
                </div>
                <p style="font-size:0.8rem;color:#666;margin-bottom:8px;font-weight:700">Derniers retours</p>
                <div style="max-height:220px;overflow-y:auto">
                    ${(feedbackStats.recents||[]).map(r=>`<div style="display:flex;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid #f0f0f0;font-size:0.8rem">
                        <span>${r.produit_nom || '(produit supprimé)'}</span>
                        <span style="color:#888;white-space:nowrap">${({plus:'👍',moins:'👎',cher:'💸',possede:'✅'})[r.choix]||r.choix} · ${new Date(r.created_at).toLocaleDateString('fr-FR')}</span>
                    </div>`).join('')}
                </div>` : '<p style="color:#888;font-size:0.85rem">Aucun retour pour le moment.</p>'}
            </div>
        </div>

        <!-- PARAMETRES -->
        <div id="tab-param" style="display:none">
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px;margin-bottom:16px">
                <h2 style="font-size:1rem;margin-bottom:6px">⚙️ Coordonnées de l'agence</h2>
                <p style="font-size:0.8rem;color:#888;margin-bottom:14px">Utilisées dans le message de succès paiement et le mot de passe oublié.</p>
                <div style="display:flex;flex-direction:column;gap:10px">
                    <input type="text" id="param-adresse" class="adm-input" placeholder="Adresse de l'agence" value="${paramMap.agence_adresse || CONFIG.AGENCE_ADRESSE || ''}">
                    <input type="text" id="param-tel" class="adm-input" placeholder="Téléphone agence (format 2376XXXXXXXX)" value="${paramMap.agence_tel || CONFIG.AGENCE_TEL || ''}">
                </div>
            </div>
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px;margin-bottom:16px">
                <h2 style="font-size:1rem;margin-bottom:6px">🖼️ Photos des catégories (page d'accueil)</h2>
                <p style="font-size:0.8rem;color:#888;margin-bottom:14px">Une vraie photo par catégorie, affichée sur les tuiles de l'accueil.</p>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px">
                    ${Object.keys(CAT_SLUGS).map(cat=>`<div style="text-align:center">
                        <div style="width:100%;aspect-ratio:1;border-radius:50%;overflow:hidden;background:#f4f6f4;margin:0 auto 8px;border:1px solid #e8e8e8">
                            <img id="param-cat-preview-${CAT_SLUGS[cat]}" src="${paramMap['cat_img_'+CAT_SLUGS[cat]] || CONFIG.CATEGORY_IMAGES[cat] || ''}" style="width:100%;height:100%;object-fit:cover;${(paramMap['cat_img_'+CAT_SLUGS[cat]] || CONFIG.CATEGORY_IMAGES[cat]) ? '' : 'display:none'}" onerror="this.style.display='none'">
                        </div>
                        <p style="font-size:0.78rem;font-weight:600;margin-bottom:6px">${cat}</p>
                        <label style="background:#f4f6f4;border:1px solid #ddd;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:0.75rem;display:inline-block">
                            ⬆️ Choisir<input type="file" accept="image/*" style="display:none" onchange="previewParamCatImg(this,'${CAT_SLUGS[cat]}')">
                        </label>
                    </div>`).join('')}
                </div>
            </div>
            <button onclick="sauvegarderParametres()" style="background:#1a5c2a;color:white;border:none;padding:12px 20px;border-radius:9px;font-weight:700;cursor:pointer">💾 Enregistrer les paramètres</button>
            <p id="param-res" style="min-height:18px;font-size:0.82rem;margin-top:8px"></p>
        </div>

        <!-- RETOURS -->
        <div id="tab-retours" style="display:none">
            <div style="background:white;border-radius:12px;border:1px solid #e8e8e8;padding:22px">
                <h2 style="font-size:1rem;margin-bottom:14px">🔄 Demandes de retour (${(retours||[]).length})</h2>
                ${!(retours||[]).length ? '<p style="color:#888">Aucune demande de retour.</p>' :
                (retours||[]).map(r=>`<div style="background:#f8f8f8;border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid #eee">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
                        <div>
                            <div style="font-family:monospace;font-weight:700;color:#1a5c2a">${r.code_commande||'—'}</div>
                            <div style="font-size:0.78rem;color:#888;margin:4px 0">${new Date(r.created_at).toLocaleString('fr-FR')}</div>
                            <div style="font-size:0.85rem;margin-top:4px">${r.motif||''}</div>
                            <span style="display:inline-block;margin-top:6px;padding:3px 10px;border-radius:8px;font-size:0.72rem;font-weight:700;background:${r.statut==='en_attente'?'#fff8f0':r.statut==='traite'?'#f0fff4':'#fff0f0'};color:${r.statut==='en_attente'?'#ff6600':r.statut==='traite'?'#2dc653':'#e63946'}">${r.statut}</span>
                        </div>
                        <div style="display:flex;gap:6px">
                            <button onclick="changerStatutRetour('${r.id}','traite')" style="background:#f0fff4;color:#2dc653;border:1px solid #b7f5c8;padding:6px 12px;border-radius:6px;font-size:0.78rem;cursor:pointer">✅ Traité</button>
                            <button onclick="changerStatutRetour('${r.id}','refuse')" style="background:#fff0f0;color:#e63946;border:1px solid #fcc;padding:6px 12px;border-radius:6px;font-size:0.78rem;cursor:pointer">❌ Refuser</button>
                        </div>
                    </div>
                </div>`).join('')}
            </div>
        </div>

        </div>
    </div>
    <style>
        .adm-tab{background:rgba(255,255,255,0.15);color:white;border:none;padding:7px 12px;border-radius:7px;cursor:pointer;font-size:0.78rem;font-weight:600;font-family:Inter,sans-serif}
        .adm-tab:hover,.adm-tab.active{background:#ff6600}
        .adm-input{background:#f4f6f4;border:1.5px solid #e8e8e8;padding:12px;color:#1a1a1a;border-radius:9px;font-size:0.9rem;width:100%;font-family:Inter,sans-serif}
        .mktg-prod-item:hover{background:#eee}
    </style>`;

    document.getElementById('mktg-type').onchange = function() {
        document.getElementById('mktg-slider-extra').style.display = this.value==='slider'?'flex':'none';
        document.getElementById('mktg-popup-extra').style.display = this.value==='popup'?'flex':'none';
    };

    showTab(adminTabActuel);
}

window.changerStatutRetour = async (id, statut) => {
    await db.from('retours').update({ statut }).eq('id', id);
    afficherPanneauAdmin();
};

let popupFlyerFile = null;
window.previewPopupFlyer = (input) => {
    popupFlyerFile = input.files[0];
    if (!popupFlyerFile) return;
    const reader = new FileReader();
    reader.onload = e => {
        document.getElementById('mktg-popup-preview-img').src = e.target.result;
        document.getElementById('mktg-popup-preview').style.display = 'block';
    };
    reader.readAsDataURL(popupFlyerFile);
};
let sliderImgFile = null;
window.previewSliderImg = (input) => {
    sliderImgFile = input.files[0];
    if (!sliderImgFile) return;
    const reader = new FileReader();
    reader.onload = e => {
        document.getElementById('mktg-slider-preview-img').src = e.target.result;
        document.getElementById('mktg-slider-preview').style.display = 'block';
    };
    reader.readAsDataURL(sliderImgFile);
};
window.filtrerProduitsPopup = () => {
    const q = document.getElementById('mktg-prod-search').value.toLowerCase();
    document.querySelectorAll('.mktg-prod-item').forEach(el => {
        el.style.display = el.dataset.nom.includes(q) ? 'flex' : 'none';
    });
};

// ===== PARAMETRES ADMIN =====
let paramCatFiles = {};
window.previewParamCatImg = (input, slug) => {
    const file = input.files[0];
    if (!file) return;
    paramCatFiles[slug] = file;
    const reader = new FileReader();
    reader.onload = e => {
        const img = document.getElementById('param-cat-preview-' + slug);
        img.src = e.target.result; img.style.display = 'block';
    };
    reader.readAsDataURL(file);
};

window.sauvegarderParametres = async () => {
    const res = document.getElementById('param-res');
    res.style.color = '#888'; res.textContent = '⏳ Enregistrement...';
    try {
        const rows = [
            { cle: 'agence_adresse', valeur: document.getElementById('param-adresse').value.trim() },
            { cle: 'agence_tel', valeur: document.getElementById('param-tel').value.trim() }
        ];
        for (const slug of Object.values(CAT_SLUGS)) {
            if (paramCatFiles[slug]) {
                const url = await uploadImage(paramCatFiles[slug]);
                rows.push({ cle: 'cat_img_' + slug, valeur: url });
            }
        }
        const { error } = await db.from('parametres').upsert(rows, { onConflict: 'cle' });
        if (error) throw error;
        paramCatFiles = {};
        res.style.color = '#2dc653'; res.textContent = '✅ Paramètres enregistrés — visibles immédiatement sur le site.';
    } catch (e) {
        res.style.color = '#e63946'; res.textContent = '❌ ' + e.message;
    }
};

function renderCmdsAdmin(data) {
    if (!data.length) return '<p style="color:#888;text-align:center;padding:20px">Aucune commande.</p>';
    window._resParCode = {}; data.forEach(r => window._resParCode[r.code] = r);
    return `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.8rem">
        <thead><tr>${['Code','Client','Zone','Total','Date & heure','Statut','Action',''].map(h=>`<th style="color:#888;font-weight:600;text-align:left;padding:8px 10px;border-bottom:2px solid #f0f0f0;font-size:0.72rem;text-transform:uppercase">${h}</th>`).join('')}</tr></thead>
        <tbody>${data.map(r=>`<tr style="border-bottom:1px solid #f8f8f8">
            <td style="padding:10px;font-family:monospace;color:#1a5c2a;font-weight:700">${r.code}</td>
            <td style="padding:10px">${r.nom_client}<br><span style="color:#888;font-size:0.72rem">${r.telephone}</span></td>
            <td style="padding:10px;color:#888;font-size:0.78rem">📍${r.zone_livraison||'—'}</td>
            <td style="padding:10px;font-weight:600">${fmt(r.total)} F</td>
            <td style="padding:10px;color:#888;font-size:0.75rem">${new Date(r.created_at).toLocaleDateString('fr-FR')} à ${new Date(r.created_at).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}</td>
            <td style="padding:10px"><span style="padding:3px 10px;border-radius:8px;font-size:0.7rem;font-weight:700;background:${r.statut==='en attente'?'#fff8f0':r.statut==='valide'?'#f0fff4':'#fff0f0'};color:${r.statut==='en attente'?'#ff6600':r.statut==='valide'?'#2dc653':'#e63946'}">${r.statut}</span></td>
            <td style="padding:10px"><select onchange="changerStatutAdmin('${r.id}',this.value)" style="background:#f4f6f4;color:#1a1a1a;border:1px solid #e8e8e8;border-radius:6px;padding:5px;font-size:0.75rem">
                <option value="">Changer...</option>
                <option value="en attente">⏳ En attente</option>
                <option value="valide">✅ Validée</option>
                <option value="livre">🚚 Livrée</option>
                <option value="annule">❌ Annulée</option>
            </select></td>
            <td style="padding:10px"><button onclick="ouvrirDetailsCmdAdmin('${r.code}')" style="background:none;border:1px solid #e8e8e8;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:0.75rem">👁️ Détails</button></td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

window.ouvrirDetailsCmdAdmin = (code) => {
    const r = window._resParCode?.[code];
    if (!r) return;
    const estPaye = r.statut==='valide' || r.statut==='livre';
    const el = document.createElement('div');
    el.className = 'modal-overlay';
    el.style.display = 'flex';
    el.style.zIndex = '5000';
    el.innerHTML = `<div class="modal" style="max-width:480px">
        <button class="modal-x" onclick="this.closest('.modal-overlay').remove()">✕</button>
        <h2 style="font-size:1.05rem;margin-bottom:14px">🧾 Commande ${r.code}</h2>
        <div style="font-size:0.85rem;line-height:1.9;color:#333">
            <div><strong>Client :</strong> ${r.nom_client} — ${r.telephone}</div>
            <div><strong>Date :</strong> ${new Date(r.created_at).toLocaleDateString('fr-FR')} à ${new Date(r.created_at).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}</div>
            <div><strong>Zone :</strong> ${r.zone_livraison||'—'} ${r.frais_livraison?`(frais: ${fmt(r.frais_livraison)} F)`:''}</div>
            <div><strong>Statut :</strong> ${r.statut}${r.paye_le ? ` — payé le ${new Date(r.paye_le).toLocaleString('fr-FR')}` : ''}</div>
            ${r.transaction_id ? `<div><strong>Référence paiement :</strong> ${r.transaction_id}</div>` : ''}
        </div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid #eee">
            <strong style="font-size:0.85rem">Articles :</strong>
            ${(r.items||[]).map(i=>`<div style="display:flex;justify-content:space-between;font-size:0.85rem;padding:4px 0">
                <span>${i.name} ×${i.qty}</span><span>${fmt((i.prix||0)*(i.qty||1))} F</span>
            </div>`).join('')}
            <div style="display:flex;justify-content:space-between;font-weight:700;color:#1a5c2a;padding-top:8px;border-top:1px solid #eee;margin-top:6px">
                <span>TOTAL</span><span>${fmt(r.total)} F</span>
            </div>
        </div>
        <button onclick="telechargerFactureAdmin('${r.code}')" style="width:100%;margin-top:16px;background:#1a5c2a;color:white;border:none;padding:11px;border-radius:8px;font-weight:700;cursor:pointer">${estPaye?'🧾 Télécharger le reçu complet':'📄 Télécharger le suivi (non payé)'}</button>
    </div>`;
    document.body.appendChild(el);
};

window.telechargerFactureAdmin = async (code) => {
    try {
        const resp = await fetch(`/api/facture?code=${encodeURIComponent(code)}`, {
            headers: { 'Authorization': 'Bearer ' + (sessionStorage.getItem('cmkt_admin_token') || '') }
        });
        if (!resp.ok) { const j = await resp.json().catch(()=>({})); alert('❌ ' + (j.error || 'Impossible de télécharger le reçu')); return; }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        try {
            const a = document.createElement('a');
            a.href = url; a.download = `facture-${code}.pdf`;
            document.body.appendChild(a); a.click(); a.remove();
        } catch (eDl) {
            window.open(url, '_blank');
        }
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
        console.error('Erreur téléchargement facture (admin):', e);
        alert('❌ Erreur lors du téléchargement : ' + (e.message || 'inconnue'));
    }
};

let adminTabActuel = 'tab-dash';
window.showTab = id => {
    adminTabActuel = id;
    ['tab-dash','tab-prods','tab-cmds','tab-users','tab-avis','tab-mktg','tab-param','tab-retours'].forEach(t=>{
        const el=document.getElementById(t); if(el) el.style.display=t===id?'block':'none';
    });
    ['tb-dash','tb-prods','tb-cmds','tb-users','tb-avis','tb-mktg','tb-param','tb-retours'].forEach(b=>{
        const el=document.getElementById(b); if(el) el.classList.toggle('active', b==='tb-'+id.replace('tab-',''));
    });
};

window.filtrerCmdsAdmin = q => {
    const data = window._res.filter(r=>r.code.toLowerCase().includes(q.toLowerCase())||r.nom_client.toLowerCase().includes(q.toLowerCase()));
    document.getElementById('cmds-admin-table').innerHTML = renderCmdsAdmin(data);
};

window.changerStatutAdmin = async (id, statut) => {
    if(!statut)return;
    await adminAction('reservations','update',{id,payload:{statut}});
    afficherPanneauAdmin();
};

window.validerAvisAdmin = async id => { await adminAction('avis','update',{id,payload:{valide:true}}); afficherPanneauAdmin(); };
window.supprimerAvisAdmin = async id => { if(!confirm('Supprimer ?'))return; await adminAction('avis','delete',{id}); afficherPanneauAdmin(); };

window.adminResetMdp = async (userId, nom, email) => {
    if (!email) { alert(`❌ ${nom} n'a pas d'email enregistré, impossible d'envoyer un lien de réinitialisation.`); return; }
    if (!confirm(`Envoyer un lien de réinitialisation de mot de passe à ${nom} (${email}) ?`)) return;
    try {
        await window.fbSendPasswordResetEmail(window.firebaseAuth, email);
        alert(`✅ Email de réinitialisation envoyé à ${email}.`);
    } catch (e) {
        alert('❌ ' + traduireErreurFirebase(e.code));
    }
};
window.adminSupprimerUtilisateur = async (userId, nom) => {
    if (!confirm(`Supprimer définitivement le profil de ${nom} ?\n\nSon profil et son historique seront détachés (irréversible). Il te restera une dernière étape manuelle pour bannir aussi son compte de connexion.`)) return;
    try {
        const r = await adminAction('utilisateurs', 'delete', { id: userId });
        afficherPanneauAdmin();
        const identifiant = r.email || r.firebase_uid || '(voir Firebase)';
        alert(`✅ Profil de ${nom} supprimé.\n\nPour finir, supprime aussi son compte de connexion dans la console Firebase :\nAuthentication → Users → cherche "${identifiant}" → icône poubelle.`);
    } catch (e) {
        alert('❌ ' + e.message);
    }
};
window.desactiverBanniere = async id => { await adminAction('bannieres','update',{id,payload:{actif:false}}); afficherPanneauAdmin(); };

window.previewAdminImg = input => {
    ajouterFichiersImage(input.files);
    input.value = ''; // permet de resélectionner/ajouter d'autres photos ensuite
};

function ajouterFichiersImage(fileList) {
    const nouvelles = Array.from(fileList || []).filter(f => f.type.startsWith('image/'));
    if (!nouvelles.length) return;
    selectedFilesAll = [...selectedFilesAll, ...nouvelles].slice(0, 8); // 8 photos max
    selectedFile = selectedFilesAll[0];
    renderAdminImgThumbs();
}

window.handleDropImages = (e) => {
    e.preventDefault();
    e.currentTarget.style.background = '#f4f6f4';
    ajouterFichiersImage(e.dataTransfer.files);
};
window.handleDragOverImages = (e) => {
    e.preventDefault();
    e.currentTarget.style.background = '#e8f5e9';
};
window.handleDragLeaveImages = (e) => {
    e.currentTarget.style.background = '#f4f6f4';
};

function renderAdminImgThumbs() {
    if (!selectedFilesAll.length) {
        document.getElementById('adm-img-preview').style.display = 'none';
        document.getElementById('adm-img-extra').innerHTML = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = e => { document.getElementById('adm-img').src = e.target.result; document.getElementById('adm-img-preview').style.display = 'inline-block'; };
    reader.readAsDataURL(selectedFilesAll[0]);

    const extra = document.getElementById('adm-img-extra');
    extra.innerHTML = '';
    selectedFilesAll.slice(1).forEach((f, idx) => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative;display:inline-block';
        const r = new FileReader();
        r.onload = e => {
            const img = document.createElement('img');
            img.src = e.target.result;
            img.style.cssText = 'width:50px;height:50px;object-fit:cover;border-radius:6px;border:1px solid #ddd';
            wrap.appendChild(img);
        };
        r.readAsDataURL(f);
        const x = document.createElement('button');
        x.textContent = '✕';
        x.type = 'button';
        x.style.cssText = 'position:absolute;top:-6px;right:-6px;background:#e63946;color:white;border:none;border-radius:50%;width:16px;height:16px;font-size:0.6rem;cursor:pointer;line-height:1;padding:0';
        x.onclick = () => { selectedFilesAll.splice(idx + 1, 1); renderAdminImgThumbs(); };
        wrap.appendChild(x);
        extra.appendChild(wrap);
    });
    if (selectedFilesAll.length > 1) {
        const note = document.createElement('span');
        note.style.cssText = 'font-size:0.72rem;color:#888';
        note.textContent = `${selectedFilesAll.length} photos — la 1ère reste la photo principale du produit`;
        extra.appendChild(note);
    }
}

window.resetAdminImg = () => {
    selectedFile=null; selectedFilesAll=[];
    const f=document.getElementById('p-img-file'); if(f)f.value='';
    const u=document.getElementById('p-img-url'); if(u)u.value='';
    const p=document.getElementById('adm-img-preview'); if(p)p.style.display='none';
    const e=document.getElementById('adm-img-extra'); if(e)e.innerHTML='';
    const l=document.getElementById('ia-lot-resultats'); if(l){l.style.display='none';l.innerHTML='';}
    const c=document.getElementById('ia-mode-lot'); if(c)c.checked=false;
};

window.analyserProduitIA = async () => {
    const res = document.getElementById('ia-res');
    const modeLot = document.getElementById('ia-mode-lot').checked;
    const fichiers = selectedFilesAll.length ? selectedFilesAll : (selectedFile ? [selectedFile] : []);
    if (!fichiers.length) { res.style.color = '#e63946'; res.textContent = '❌ Uploade d\'abord au moins une photo.'; return; }
    if (modeLot && fichiers.length < 2) { res.style.color = '#e63946'; res.textContent = '❌ Le mode "produits différents" demande au moins 2 photos.'; return; }
    const btn = document.getElementById('btn-ia-analyser');
    btn.disabled = true; btn.textContent = '⏳ Analyse...';
    res.style.color = '#888'; res.textContent = modeLot ? `L'IA regarde les ${fichiers.length} photos séparément...` : (fichiers.length > 1 ? `L'IA regarde les ${fichiers.length} photos...` : 'L\'IA regarde la photo...');
    try {
        const images = await Promise.all(fichiers.map(f => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve({ data: reader.result.split(',')[1], media_type: f.type || 'image/jpeg' });
            reader.onerror = reject;
            reader.readAsDataURL(f);
        })));
        const resp = await fetch('/api/analyser-produit', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (sessionStorage.getItem('cmkt_admin_token') || '') },
            body: JSON.stringify({ images, mode: modeLot ? 'lot' : 'unique' })
        });
        const data = await resp.json();
        if (!resp.ok || data.error) throw new Error(data.error || 'Erreur IA');

        if (modeLot) {
            const liste = Array.isArray(data) ? data : (data.produits || []);
            afficherResultatsLot(liste, fichiers);
            res.style.color = '#2dc653'; res.textContent = `✅ ${liste.length} produit(s) détecté(s) — complète le prix et la quantité de chacun ci-dessous.`;
        } else {
            if (data.name) document.getElementById('p-name').value = data.name;
            if (data.description) document.getElementById('p-desc').value = data.description;
            if (data.category) document.getElementById('p-cat').value = data.category;
            res.style.color = '#2dc653'; res.textContent = '✅ Nom, catégorie et description pré-remplis — vérifie et ajoute le prix + la quantité.';
        }
    } catch (e) {
        res.style.color = '#e63946'; res.textContent = '❌ ' + e.message;
    }
    btn.disabled = false; btn.textContent = "🤖 Analyser avec l'IA";
};

// Affiche une fiche éditable par produit détecté en mode lot, avec validation individuelle
function afficherResultatsLot(produits, fichiers) {
    const zone = document.getElementById('ia-lot-resultats');
    zone.style.display = 'flex';
    zone.innerHTML = produits.map((p, i) => `
        <div class="ia-lot-carte" id="ia-lot-carte-${i}" style="background:#f8f9fb;border:1px solid #e0e6f0;border-radius:10px;padding:14px;display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start">
            <img id="ia-lot-img-${i}" style="width:70px;height:70px;object-fit:cover;border-radius:8px;flex-shrink:0">
            <div style="flex:1;min-width:220px;display:flex;flex-direction:column;gap:6px">
                <input type="text" id="ia-lot-name-${i}" class="adm-input" value="${(p.name||'').replace(/"/g,'&quot;')}" placeholder="Nom du produit">
                <textarea id="ia-lot-desc-${i}" class="adm-input" rows="2" placeholder="Description">${p.description||''}</textarea>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px">
                    <select id="ia-lot-cat-${i}" class="adm-input"><option value="Téléphonie">📱 Téléphonie</option><option value="Accessoires">🎧 Accessoires</option><option value="Électronique">💻 Électronique</option><option value="Réseau">📡 Réseau</option><option value="Gaming">🎮 Gaming</option><option value="Autre">📦 Autre</option></select>
                    <input type="number" id="ia-lot-achat-${i}" class="adm-input" placeholder="Prix achat *">
                    <input type="number" id="ia-lot-vente-${i}" class="adm-input" placeholder="Prix vente *">
                    <input type="number" id="ia-lot-qte-${i}" class="adm-input" placeholder="Quantité *">
                </div>
                <button onclick="validerProduitLot(${i})" id="ia-lot-btn-${i}" style="align-self:flex-start;background:#1a5c2a;color:white;border:none;padding:8px 16px;border-radius:7px;font-size:0.82rem;cursor:pointer;font-weight:600">✅ Ajouter ce produit</button>
                <p id="ia-lot-res-${i}" style="font-size:0.76rem;min-height:14px"></p>
            </div>
        </div>`).join('');

    // Preview + catégorie pré-sélectionnée pour chaque carte
    produits.forEach((p, i) => {
        const f = fichiers[i];
        if (f) { const r = new FileReader(); r.onload = e => { document.getElementById(`ia-lot-img-${i}`).src = e.target.result; }; r.readAsDataURL(f); }
        const sel = document.getElementById(`ia-lot-cat-${i}`);
        if (sel && p.category) sel.value = p.category;
    });

    window._iaLotFichiers = fichiers;
}

window.validerProduitLot = async (i) => {
    const res = document.getElementById(`ia-lot-res-${i}`);
    const btn = document.getElementById(`ia-lot-btn-${i}`);
    const name = document.getElementById(`ia-lot-name-${i}`).value.trim();
    const desc = document.getElementById(`ia-lot-desc-${i}`).value.trim();
    const cat = document.getElementById(`ia-lot-cat-${i}`).value;
    const achat = parseFloat(document.getElementById(`ia-lot-achat-${i}`).value);
    const vente = parseFloat(document.getElementById(`ia-lot-vente-${i}`).value);
    const qte = parseInt(document.getElementById(`ia-lot-qte-${i}`).value);
    res.textContent = '';
    if (!name) { res.style.color = '#e63946'; res.textContent = '❌ Nom requis'; return; }
    if (!achat || achat <= 0) { res.style.color = '#e63946'; res.textContent = '❌ Prix d\'achat requis'; return; }
    if (!vente || vente <= 0) { res.style.color = '#e63946'; res.textContent = '❌ Prix de vente requis'; return; }
    if (!qte || qte < 0) { res.style.color = '#e63946'; res.textContent = '❌ Quantité requise'; return; }
    btn.disabled = true; btn.textContent = '⏳ Ajout...';
    try {
        const fichier = window._iaLotFichiers[i];
        const imageUrl = fichier ? await uploadImage(fichier) : null;
        await adminAction('products', 'insert', { payload: {
            name, description: desc, category: cat,
            purchase_price: achat, resale_price: vente, quantity: qte, image_url: imageUrl
        }});
        res.style.color = '#2dc653'; res.textContent = '✅ Produit ajouté !';
        btn.textContent = '✅ Ajouté'; btn.style.background = '#888'; btn.disabled = true;
        rafraichirProduits();
        setTimeout(() => {
            const carte = document.getElementById(`ia-lot-carte-${i}`);
            if (carte) carte.remove();
            const zone = document.getElementById('ia-lot-resultats');
            if (zone && !zone.children.length) {
                zone.style.display = 'none'; zone.innerHTML = '';
                resetAdminImg(); // vide aussi les photos et la case "produits différents" en haut
                const msg = document.getElementById('prod-msg');
                if (msg) { msg.style.color = '#2dc653'; msg.textContent = '✅ Tous les produits du lot ont été ajoutés !'; }
            }
        }, 900);
    } catch (e) {
        res.style.color = '#e63946'; res.textContent = '❌ ' + e.message;
        btn.disabled = false; btn.textContent = '✅ Ajouter ce produit';
    }
};

window.sauvegarderProduit = async () => {
    const msg=document.getElementById('prod-msg');
    const name=document.getElementById('p-name').value.trim();
    const qty=parseInt(document.getElementById('p-qty').value);
    const achat=parseFloat(document.getElementById('p-achat').value);
    const vente=parseFloat(document.getElementById('p-vente').value);
    if(!name||!qty||!achat||!vente){msg.style.color='#e63946';msg.textContent='❌ Remplissez les champs obligatoires';return;}
    msg.style.color='#888';msg.textContent='Enregistrement...';
    let imageUrl=document.getElementById('p-img-url').value.trim();
    if(selectedFile){try{imageUrl=await uploadImage(selectedFile);}catch(e){msg.style.color='#e63946';msg.textContent='❌ Upload: '+e.message;return;}}
    const prod={name,description:document.getElementById('p-desc').value.trim()||null,category:document.getElementById('p-cat').value,quantity:qty,purchase_price:achat,resale_price:vente,image_url:imageUrl||null,promo_active:document.getElementById('p-promo-chk').checked,promo_prix:parseFloat(document.getElementById('p-promo').value)||null,flash_active:document.getElementById('p-flash-chk').checked,flash_fin:document.getElementById('p-flash-fin').value?new Date(document.getElementById('p-flash-fin').value).toISOString():null};
    try {
        await (editingId ? adminAction('products','update',{id:editingId,payload:prod}) : adminAction('products','insert',{payload:prod}));
    } catch(e) { msg.style.color='#e63946'; msg.textContent='❌ '+e.message; return; }
    msg.style.color='#2dc653';msg.textContent='✅ Enregistré !';
    annulerEdit();
    rafraichirProduits();
};

window.chargerEditProduit = id => {
    const p=window._prods.find(x=>x.id===id); if(!p)return;
    editingId=id;
    document.getElementById('prod-form-title').textContent='✏️ Modifier le produit';
    document.getElementById('p-name').value=p.name;
    document.getElementById('p-desc').value=p.description||'';
    document.getElementById('p-cat').value=p.category;
    document.getElementById('p-qty').value=p.quantity;
    document.getElementById('p-achat').value=p.purchase_price;
    document.getElementById('p-vente').value=p.resale_price;
    document.getElementById('p-promo').value=p.promo_prix||'';
    document.getElementById('p-promo-chk').checked=p.promo_active||false;
    document.getElementById('p-flash-chk').checked=p.flash_active||false;
    if(p.image_url){document.getElementById('p-img-url').value=p.image_url;document.getElementById('adm-img').src=p.image_url;document.getElementById('adm-img-preview').style.display='inline-block';}
    document.getElementById('btn-annuler-edit').style.display='';
    showTab('tab-prods'); window.scrollTo({top:0,behavior:'smooth'});
};

window.annulerEdit = () => {
    editingId=null; selectedFile=null; selectedFilesAll=[];
    ['p-name','p-desc','p-qty','p-achat','p-vente','p-promo','p-img-url','p-flash-fin'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    const c=document.getElementById('p-promo-chk');if(c)c.checked=false;
    const f=document.getElementById('p-flash-chk');if(f)f.checked=false;
    const pf=document.getElementById('p-img-file');if(pf)pf.value='';
    const img=document.getElementById('adm-img');if(img)img.src='';
    const w=document.getElementById('adm-img-preview');if(w)w.style.display='none';
    const ex=document.getElementById('adm-img-extra');if(ex)ex.innerHTML='';
    const ia=document.getElementById('ia-res');if(ia)ia.textContent='';
    const t=document.getElementById('prod-form-title');if(t)t.textContent='➕ Ajouter un Produit';
    const b=document.getElementById('btn-annuler-edit');if(b)b.style.display='none';
};

window.supprimerProduit = async id => { if(!confirm('Supprimer ce produit ?'))return; await adminAction('products','delete',{id}); rafraichirProduits(); };
window.toggleFlash = async (id, actif) => { await adminAction('products','update',{id,payload:{flash_active:!actif}}); rafraichirProduits(); };

window.publierMessage = async () => {
    const msg=document.getElementById('mktg-msg').value.trim();
    const type=document.getElementById('mktg-type').value;
    const res=document.getElementById('mktg-res');
    if(!msg){res.style.color='#e63946';res.textContent='❌ Message vide';return;}
    const payload={message:msg,type,actif:true};
    if(type==='slider'){
        let sliderUrl = document.getElementById('mktg-img-url').value.trim();
        if (sliderImgFile) {
            res.style.color='#888'; res.textContent='⏳ Envoi de l\'image...';
            try { sliderUrl = await uploadImage(sliderImgFile); }
            catch(e){ res.style.color='#e63946'; res.textContent='❌ Upload: '+e.message; return; }
        }
        payload.titre=document.getElementById('mktg-titre').value;
        payload.tag=document.getElementById('mktg-tag').value;
        payload.image_url=sliderUrl;
        payload.btn_texte=document.getElementById('mktg-btn-txt').value;
        payload.produit_id = document.getElementById('mktg-slide-produit').value || null;
        const pa=document.getElementById('mktg-prix-actuel').value; payload.prix_actuel = pa?parseFloat(pa):null;
        const pan=document.getElementById('mktg-prix-ancien').value; payload.prix_ancien = pan?parseFloat(pan):null;
    }
    if(type==='popup'){
        let flyerUrl = document.getElementById('mktg-popup-img').value.trim();
        if (popupFlyerFile) {
            res.style.color='#888'; res.textContent='⏳ Envoi de l\'image...';
            try { flyerUrl = await uploadImage(popupFlyerFile); }
            catch(e){ res.style.color='#e63946'; res.textContent='❌ Upload: '+e.message; return; }
        }
        payload.image_url = flyerUrl || null;
        payload.lien = document.getElementById('mktg-popup-lien').value.trim() || null;
        const idsChoisis = Array.from(document.querySelectorAll('.mktg-prod-chk:checked')).map(c=>c.value).slice(0,4);
        payload.produits_ids = idsChoisis.length ? idsChoisis : null;
    }
    try { await adminAction('bannieres','insert',{payload}); }
    catch(e){res.style.color='#e63946';res.textContent='❌ '+e.message;return;}
    res.style.color='#2dc653';res.textContent='✅ Publié !';
    document.getElementById('mktg-msg').value='';
    popupFlyerFile = null;
    sliderImgFile = null;
    setTimeout(()=>afficherPanneauAdmin(),600);
};

// api/_lib/admin/admin-client.js
// CODE DU PANNEAU ADMIN (côté navigateur). Ce fichier n'est JAMAIS servi comme fichier public :
// il est envoyé uniquement par GET /api/admin-auth?bundle=1 à un administrateur connecté
// (jeton signé valide). Un visiteur, un robot ou un curieux reçoit une erreur 401, jamais ce code.
// Pour modifier le panneau admin : modifier CE fichier, puis redéployer.

// ===== OUTILS PARTAGÉS (copie de ceux du site client) =====
// (db, evenementInstallPwa : déjà définis par /admin-login.js, chargé avant ce panneau)

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


const fmt = n => parseInt(n).toLocaleString('fr-FR');
const $ = id => document.getElementById(id);

function echapperHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

let selectedFile = null, selectedFilesAll = [], editingId = null;

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

function prixCharme(prix) {
    const p = Math.round(prix || 0);
    return (p > 0 && p % 100 === 0) ? p - 1 : p;
}

const CAT_SLUGS = { "Téléphonie":"telephonie", "Accessoires":"accessoires", "Électronique":"electronique", "Gaming":"gaming", "Réseau":"reseau", "Flash":"flash" };

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

function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - base64.length % 4) % 4);
    const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64Safe);
    return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

window.activerNotifsAdmin = async () => {
    const statut = $('admin-notif-statut');
    statut.textContent = '...';
    try {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) { statut.textContent = "❌ Non supporté sur ce navigateur."; return; }
        if (!CONFIG.VAPID_PUBLIC_KEY) { statut.textContent = '❌ Clé VAPID manquante côté site.'; return; }
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') { statut.textContent = '❌ Permission refusée.'; return; }

        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(CONFIG.VAPID_PUBLIC_KEY)
            });
        }
        const resp = await fetch('/api/push-subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (sessionStorage.getItem('cmkt_admin_token') || '') },
            body: JSON.stringify({ subscription: sub.toJSON() })
        });
        if (!resp.ok) { const j = await resp.json().catch(()=>({})); statut.textContent = '❌ ' + (j.error || 'Erreur serveur'); return; }
        statut.textContent = '✅ Activé sur cet appareil !';
    } catch (e) {
        statut.textContent = '❌ ' + (e.message || 'Erreur');
    }
};

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

function bienvenueLignes(actif, message) {
    const m = String(message || '').trim().slice(0, BIENVENUE_MAX);
    if (actif && !m) throw new Error('Écrivez le message de bienvenue avant de l\'activer.');
    return [{ cle: 'bienvenue_actif', valeur: actif ? '1' : '0' }, { cle: 'bienvenue_message', valeur: m }];
}

window.apercuBienvenue = () => {
    const champ = document.getElementById('param-bienvenue-msg');
    const texte = champ ? champ.value.trim().slice(0, BIENVENUE_MAX) : '';
    if (!texte) {
        const r = document.getElementById('param-res');
        if (r) { r.style.color = '#D9534F'; r.textContent = 'Écrivez d\'abord un message pour voir l\'aperçu.'; }
        return;
    }
    bienvenueAfficher(texte);
};

function ouvrirPresentationTelechargement() {
    const dejaInstallee = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const estIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const estAdmin = window.location.pathname.replace(/\//g, '') === 'admin-cmr2025';

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
async function adminAction(ressource, action, { id, payload, forcer } = {}) {
    const resp = await fetch('/api/admin-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (sessionStorage.getItem('cmkt_admin_token') || '') },
        body: JSON.stringify({ ressource, action, id, payload, forcer })
    });
    const data = await resp.json();
    if (!resp.ok) { const err = new Error(data.error || 'Erreur admin'); err.code = data.code; err.doublons = data.doublons; throw err; }
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

    const [{data:prods},usersResult,reservationsResult,{data:avisListe},{data:bannieres},{data:params},retoursResult,feedbackStats,codesPromoResult,visiteursResult,offresResult]=await Promise.all([
        db.from('products').select('*').order('created_at',{ascending:false}),
        adminAction('utilisateurs','list').catch(()=>({data:[]})),
        adminAction('reservations','list').catch(()=>({data:[]})),
        db.from('avis').select('*').eq('valide',false),
        db.from('bannières').select('*').eq('actif',true),
        db.from('parametres').select('*'),
        adminAction('retours','list').catch(()=>({data:[]})),
        adminAction('feedback_produits','stats').catch(()=>({total:0,parChoix:{},parProduit:{},recents:[]})),
        adminAction('codes_promo','list').catch(()=>({data:[]})),
        adminAction('visiteurs','list').catch(()=>({data:[]})),
        adminAction('offres_groupees','list').catch(()=>({data:[]}))
    ]);
    const users = usersResult.data;
    const reservations = reservationsResult.data || [];
    const retours = retoursResult.data || [];
    const codesPromo = codesPromoResult.data || [];
    const visiteurs = visiteursResult.data || [];
    const offresGroupees = offresResult.data || [];
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
    window._prods=prods||[]; window._res=commandesPayees; window._codesPromo=codesPromo; window._offresGroupees=offresGroupees; window._bannieres=bannieres;

    page.innerHTML=`
    <div style="font-family:Inter,sans-serif">
        <div style="background:linear-gradient(135deg,#1F6B3A,#164F2B);color:white;padding:16px 26px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;position:sticky;top:0;z-index:10;box-shadow:0 2px 14px rgba(0,0,0,0.12)">
            <h1 style="font-family:Poppins,sans-serif;font-size:1.1rem;margin:0;font-weight:600;letter-spacing:0.2px">⚙️ Kapmaket Admin</h1>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button onclick="showTab('tab-dash')" class="adm-tab active" id="tb-dash">📊 Dashboard</button>
                <button onclick="showTab('tab-prods')" class="adm-tab" id="tb-prods">📦 Produits</button>
                <button onclick="showTab('tab-cmds')" class="adm-tab" id="tb-cmds">🧾 Commandes</button>
                <button onclick="showTab('tab-users')" class="adm-tab" id="tb-users">👥 Clients</button>
                <button onclick="showTab('tab-avis')" class="adm-tab" id="tb-avis">⭐ Avis(${(avisListe||[]).length})</button>
                <button onclick="showTab('tab-mktg')" class="adm-tab" id="tb-mktg">📢 Marketing</button>
                <button onclick="showTab('tab-param')" class="adm-tab" id="tb-param">⚙️ Paramètres</button>
                <button onclick="showTab('tab-retours')" class="adm-tab" id="tb-retours">🔄 Retours</button>
                <button onclick="showTab('tab-promo')" class="adm-tab" id="tb-promo">🏷️ Codes promo</button>
                <button onclick="showTab('tab-visiteurs')" class="adm-tab" id="tb-visiteurs">👥 Visiteurs</button>
                <button onclick="showTab('tab-demande');chargerDemande(30)" class="adm-tab" id="tb-demande">📈 Demande clients</button>
                <button onclick="showTab('tab-combo')" class="adm-tab" id="tb-combo">⚡ Flash Combo</button>
                <button onclick="window.location.href='/'" class="adm-tab">🏪 Site</button>
                <button onclick="ouvrirPresentationTelechargement()" class="adm-tab" style="background:rgba(255,255,255,0.15)">📲 Installer l'app Admin</button>
            </div>
        </div>
        <div style="max-width:1200px;margin:0 auto;padding:20px 16px">

        <!-- DASHBOARD -->
        <div id="tab-dash">
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px">
                ${[['💰','Total ventes',fmt(totalV)+' F','tab-cmds'],['🧾','Commandes',commandesPayees.length,'tab-cmds'],['⏳','En attente',enAtt,'tab-cmds'],['📦','Produits',(prods||[]).length,'tab-prods'],['👥','Clients',(users||[]).length,'tab-users'],['⚠️','Alertes stock',sfaible.length+szero.length,'tab-prods']].map(([ico,lbl,val,cible])=>`
                <div onclick="showTab('${cible}')" style="background:white;border:1px solid #eef0ee;border-radius:16px;padding:18px;text-align:center;box-shadow:0 2px 10px rgba(20,40,25,0.05);transition:transform 0.15s ease;cursor:pointer" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform='none'">
                    <div style="font-size:1.7rem;margin-bottom:6px">${ico}</div>
                    <div style="font-size:1.2rem;font-weight:800;color:#1F6B3A;font-family:Poppins,sans-serif">${val}</div>
                    <div style="color:#888;font-size:0.75rem;margin-top:2px">${lbl}</div>
                </div>`).join('')}
            </div>
            ${(sfaible.length+szero.length)>0?`<div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:22px;margin-bottom:16px">
                <h2 style="font-size:1rem;margin-bottom:12px">⚠️ Alertes Stock</h2>
                ${szero.map(p=>`<div style="display:flex;justify-content:space-between;background:#fff0f0;border:1px solid #fcc;border-radius:8px;padding:10px 14px;margin-bottom:8px"><span>🔴 <strong>${p.name}</strong></span><span style="color:#D9534F">ÉPUISÉ</span></div>`).join('')}
                ${sfaible.map(p=>`<div style="display:flex;justify-content:space-between;background:#fff8f0;border:1px solid #fdd;border-radius:8px;padding:10px 14px;margin-bottom:8px"><span>🟡 <strong>${p.name}</strong></span><span style="color:#E8792E">${p.quantity} restant(s)</span></div>`).join('')}
            </div>`:''}
        </div>

        <!-- PRODUITS -->
        <div id="tab-prods" style="display:none">
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px;margin-bottom:16px">
                <h2 id="prod-form-title" style="font-size:1rem;margin-bottom:16px">➕ Ajouter un Produit</h2>
                <div style="display:flex;flex-direction:column;gap:10px">
                    <input type="text" id="p-name" placeholder="Nom du produit *" class="adm-input" autocomplete="off">
                    <div id="p-doublon" class="doublon-alerte" style="display:none"></div>
                    <div id="p-doublon-photo" class="doublon-alerte" style="display:none"></div>
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
                            <button onclick="resetAdminImg()" style="position:absolute;top:4px;right:4px;background:rgba(255,255,255,0.9);color:#D9534F;border:none;border-radius:4px;padding:3px 7px;font-size:0.75rem;cursor:pointer">✕</button>
                        </div>
                        <div id="adm-img-extra" style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;align-items:center"></div>
                    </div>
                    <div id="ia-lot-resultats" style="display:none;flex-direction:column;gap:10px"></div>
                    <div style="display:flex;gap:10px">
                        <button onclick="sauvegarderProduit()" style="flex:1;background:#1F6B3A;color:white;border:none;padding:12px;border-radius:9px;font-weight:700;cursor:pointer;font-size:0.95rem">Enregistrer</button>
                        <button id="btn-annuler-edit" onclick="annulerEdit()" style="display:none;background:#fff0f0;color:#D9534F;border:1px solid #fcc;padding:12px 16px;border-radius:9px;font-weight:600;cursor:pointer">Annuler</button>
                    </div>
                    <p id="prod-msg" style="min-height:18px;font-size:0.82rem"></p>
                </div>
            </div>
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:14px">
                    <h2 style="font-size:1rem;margin:0">📦 Produits (<span id="prods-count">${(prods||[]).length}</span>)</h2>
                    <button type="button" class="doublon-btn" style="padding:7px 12px;color:#1a6b3c" onclick="ouvrirScanDoublons()">🔎 Scanner les doublons</button>
                </div>
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
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px">
                <h2 style="font-size:1rem;margin-bottom:14px">🧾 Commandes</h2>
                <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
                    <input type="text" id="cmd-search" placeholder="🔎 Rechercher code ou client..." oninput="filtrerCmdsAdmin(this.value)" style="flex:1;min-width:200px;background:#f4f6f4;border:1.5px solid #eef0ee;padding:10px 14px;color:#1a1a1a;border-radius:9px;font-size:0.88rem;font-family:Inter,sans-serif">
                    <button onclick="exporterCommandesCsv()" style="background:#f0fff4;color:#3FA66B;border:1px solid #b7f5c8;padding:10px 16px;border-radius:9px;font-size:0.85rem;font-weight:600;cursor:pointer;white-space:nowrap">📊 Exporter en CSV</button>
                </div>
                <div id="cmds-admin-table">${renderCmdsAdmin(commandesPayees)}</div>
            </div>
        </div>

        <!-- CLIENTS -->
        <div id="tab-users" style="display:none">
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px">
                <h2 style="font-size:1rem;margin-bottom:14px">👥 Clients inscrits (${(users||[]).length})</h2>
                <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.82rem">
                    <thead><tr>${['Nom','Téléphone','Email','Inscrit le','Action'].map(h=>`<th style="color:#888;font-weight:600;text-align:left;padding:8px 10px;border-bottom:2px solid #f0f0f0;font-size:0.75rem">${h}</th>`).join('')}</tr></thead>
                    <tbody>${(users||[]).map(u=>`<tr style="border-bottom:1px solid #f8f8f8">
                        <td style="padding:10px"><strong>${echapperHtml(u.nom)}</strong></td>
                        <td style="padding:10px">📞 ${echapperHtml(u.telephone)}</td>
                        <td style="padding:10px;color:#888">${echapperHtml(u.email)||'—'}</td>
                        <td style="padding:10px;color:#888;font-size:0.78rem">${new Date(u.created_at).toLocaleDateString('fr-FR')}</td>
                        <td style="padding:10px"><button onclick="adminResetMdp('${u.id}','${u.nom.replace(/'/g,"\\'")}','${u.email||''}')" style="background:#fff8f0;color:#E8792E;border:1px solid #fdd;padding:5px 10px;border-radius:6px;font-size:0.75rem;cursor:pointer;margin-right:6px">🔑 Réinitialiser mdp</button><button onclick="adminSupprimerUtilisateur('${u.id}','${u.nom.replace(/'/g,"\\'")}')" style="background:#fff0f0;color:#D9534F;border:1px solid #fcc;padding:5px 10px;border-radius:6px;font-size:0.75rem;cursor:pointer">🗑️ Supprimer</button></td>
                    </tr>`).join('')}</tbody>
                </table></div>
            </div>
        </div>

        <!-- AVIS -->
        <div id="tab-avis" style="display:none">
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px">
                <h2 style="font-size:1rem;margin-bottom:14px">⭐ Avis en attente</h2>
                ${!(avisListe||[]).length?'<p style="color:#888">Aucun avis en attente.</p>'
                :(avisListe||[]).map(a=>`<div style="background:#f8f8f8;border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid #eee">
                    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
                        <div><strong>${echapperHtml(a.nom_client)}</strong> — <span style="color:#f4c430">${'★'.repeat(a.note)}</span></div>
                        <div style="display:flex;gap:6px">
                            <button onclick="validerAvisAdmin('${a.id}')" style="background:#f0fff4;color:#3FA66B;border:1px solid #b7f5c8;padding:6px 12px;border-radius:6px;font-size:0.8rem;cursor:pointer">✅ Valider</button>
                            <button onclick="supprimerAvisAdmin('${a.id}')" style="background:#fff0f0;color:#D9534F;border:1px solid #fcc;padding:6px 12px;border-radius:6px;font-size:0.8rem;cursor:pointer">🗑️</button>
                        </div>
                    </div>
                    ${a.commentaire?`<p style="color:#555;font-size:0.85rem;margin-top:6px">${echapperHtml(a.commentaire)}</p>`:''}
                    ${a.photo_url?`<img src="${a.photo_url}" style="width:70px;height:70px;object-fit:cover;border-radius:6px;margin-top:8px">`:''}
                </div>`).join('')}
            </div>
        </div>

        <!-- MARKETING -->
        <div id="tab-mktg" style="display:none">
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px;margin-bottom:16px">
                <h2 id="mktg-form-title" style="font-size:1rem;margin-bottom:14px">📢 Publier un message</h2>
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
                        <div style="background:#f4f6f4;border:1.5px solid #eef0ee;border-radius:8px;padding:12px">
                            <p style="font-size:0.82rem;color:#888;margin-bottom:8px">🛍️ Produits à mettre en avant dans le popup (max 4 — sinon les ventes flash s'affichent automatiquement)</p>
                            <input type="text" id="mktg-prod-search" placeholder="Rechercher un produit..." class="adm-input" style="margin-bottom:8px" oninput="filtrerProduitsPopup()">
                            <div id="mktg-prod-liste" style="max-height:180px;overflow-y:auto;display:flex;flex-direction:column;gap:4px">
                                ${(prods||[]).map(p=>`<label class="mktg-prod-item" data-nom="${(p.name||'').toLowerCase()}" style="display:flex;align-items:center;gap:8px;padding:6px;border-radius:6px;font-size:0.82rem;cursor:pointer">
                                    <input type="checkbox" value="${p.id}" class="mktg-prod-chk"> ${p.image_url?`<img src="${p.image_url}" style="width:28px;height:28px;object-fit:cover;border-radius:4px">`:'📦'} ${p.name} <span style="color:#888;margin-left:auto">${fmt(getPrix(p))} F</span>
                                </label>`).join('')}
                            </div>
                        </div>
                    </div>
                    <button id="btn-publier-mktg" onclick="publierMessage()" style="background:#1F6B3A;color:white;border:none;padding:12px;border-radius:9px;font-weight:700;cursor:pointer">Publier</button>
                    <button id="btn-annuler-edit-mktg" onclick="annulerEditBanniere()" style="display:none;background:#f4f6f4;color:#555;border:1px solid #ddd;padding:12px;border-radius:9px;font-weight:600;cursor:pointer">Annuler</button>
                    <p id="mktg-res" style="min-height:18px;font-size:0.82rem"></p>
                </div>
            </div>
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px">
                <h2 style="font-size:1rem;margin-bottom:14px">Messages actifs</h2>
                <div id="mktg-liste">${(bannieres||[]).length?
                    (bannieres||[]).map(b=>`<div style="background:#f8f8f8;border-radius:8px;padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
                        <div style="display:flex;align-items:center;gap:10px">
                            ${b.image_url?`<img src="${b.image_url}" style="width:44px;height:44px;object-fit:cover;border-radius:6px">`:''}
                            <div><span style="background:${b.type==='popup'?'#0088ff':b.type==='slider'?'#E8792E':'#1F6B3A'};color:white;padding:2px 8px;border-radius:4px;font-size:0.72rem;font-weight:700">${b.type.toUpperCase()}</span><span style="margin-left:8px;font-size:0.88rem">${b.message}</span>${b.produits_ids?.length?`<span style="margin-left:8px;color:#888;font-size:0.72rem">🛍️ ${b.produits_ids.length} produit(s)</span>`:''}</div>
                        </div>
                        <div style="display:flex;gap:6px;flex-wrap:wrap">
                            <button onclick="chargerEditBanniere('${b.id}')" style="background:#eef6ff;color:#1a5c9c;border:1px solid #cfe4fb;padding:6px 12px;border-radius:6px;font-size:0.8rem;cursor:pointer">✏️ Modifier</button>
                            <button onclick="toggleBanniere('${b.id}',${!b.actif})" style="background:#fff8f0;color:#E8792E;border:1px solid #ffd8b0;padding:6px 12px;border-radius:6px;font-size:0.8rem;cursor:pointer">${b.actif?'⏸️ Désactiver':'▶️ Activer'}</button>
                            <button onclick="supprimerBanniere('${b.id}')" style="background:#fff0f0;color:#D9534F;border:1px solid #fcc;padding:6px 12px;border-radius:6px;font-size:0.8rem;cursor:pointer">🗑️ Supprimer</button>
                        </div>
                    </div>`).join(''):'<p style="color:#888">Aucun message actif.</p>'}
                </div>
            </div>
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px">
                <h2 style="font-size:1rem;margin-bottom:4px">📊 Retours des clients (fiche produit)</h2>
                <p style="font-size:0.8rem;color:#888;margin-bottom:14px">${feedbackStats.total || 0} retour(s) collecté(s) au total.</p>
                ${feedbackStats.total ? `
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px">
                    ${[
                        {id:'plus',label:'👍 Veulent en voir plus',color:'#0088ff'},
                        {id:'moins',label:'👎 Ne veulent plus voir',color:'#D9534F'},
                        {id:'cher',label:'💸 Trop cher',color:'#E8792E'},
                        {id:'possede',label:'✅ Déjà acheté',color:'#3FA66B'}
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
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px;margin-bottom:16px">
                <h2 style="font-size:1rem;margin-bottom:6px">🔔 Notifications nouvelles commandes</h2>
                <p style="font-size:0.8rem;color:#888;margin-bottom:14px">Reçois une alerte sur cet appareil dès qu'une commande est payée et prête à être préparée (empaquetage / livraison). À activer sur chaque appareil utilisé en boutique.</p>
                <button onclick="activerNotifsAdmin()" style="background:#f0fff4;color:#3FA66B;border:1px solid #b7f5c8;padding:10px 18px;border-radius:8px;font-size:0.85rem;font-weight:600;cursor:pointer">🔔 Activer sur cet appareil</button>
                <span id="admin-notif-statut" style="margin-left:10px;font-size:0.8rem;color:#888"></span>
            </div>
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px;margin-bottom:16px">
                <h2 style="font-size:1rem;margin-bottom:6px">⚡ Vitesse du site : optimiser les images</h2>
                <p style="font-size:0.8rem;color:#888;margin-bottom:14px">Réduit les photos trop lourdes (plus de 120 Ko) à 1000 px maximum et crée une petite miniature de chaque photo pour les cartes, le slider et les tuiles : le site s'affiche beaucoup plus vite sur téléphone. Les adresses des images ne changent pas, et chaque original est gardé dans le dossier « _originaux » du stockage.</p>
                <button type="button" id="btn-opt-img" onclick="optimiserImagesSite()" style="background:#f0fff4;color:#3FA66B;border:1px solid #b7f5c8;padding:10px 18px;border-radius:8px;font-size:0.85rem;font-weight:600;cursor:pointer">🔎 Analyser et optimiser mes images</button>
                <div id="opt-img-barre" style="display:none;height:8px;border-radius:999px;background:#eef0ee;overflow:hidden;margin-top:12px"><div id="opt-img-rempli" style="height:100%;width:0;background:#3FA66B;transition:width .2s"></div></div>
                <p id="opt-img-res" style="font-size:0.82rem;color:#888;margin-top:10px"></p>
            </div>
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px;margin-bottom:16px">
                <h2 style="font-size:1rem;margin-bottom:6px">⚙️ Coordonnées de l'agence</h2>
                <p style="font-size:0.8rem;color:#888;margin-bottom:14px">Utilisées dans le message de succès paiement et le mot de passe oublié.</p>
                <div style="display:flex;flex-direction:column;gap:10px">
                    <input type="text" id="param-adresse" class="adm-input" placeholder="Adresse de l'agence" value="${paramMap.agence_adresse || CONFIG.AGENCE_ADRESSE || ''}">
                    <input type="text" id="param-tel" class="adm-input" placeholder="Téléphone agence (format 2376XXXXXXXX)" value="${paramMap.agence_tel || CONFIG.AGENCE_TEL || ''}">
                </div>
            </div>
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px;margin-bottom:16px">
                <h2 style="font-size:1rem;margin-bottom:6px">🖼️ Photos des catégories (page d'accueil)</h2>
                <p style="font-size:0.8rem;color:#888;margin-bottom:14px">Une vraie photo par catégorie, affichée sur les tuiles de l'accueil.</p>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px">
                    ${Object.keys(CAT_SLUGS).map(cat=>`<div style="text-align:center">
                        <div style="width:100%;aspect-ratio:1;border-radius:50%;overflow:hidden;background:#f4f6f4;margin:0 auto 8px;border:1px solid #eef0ee">
                            <img id="param-cat-preview-${CAT_SLUGS[cat]}" src="${paramMap['cat_img_'+CAT_SLUGS[cat]] || CONFIG.CATEGORY_IMAGES[cat] || ''}" style="width:100%;height:100%;object-fit:cover;${(paramMap['cat_img_'+CAT_SLUGS[cat]] || CONFIG.CATEGORY_IMAGES[cat]) ? '' : 'display:none'}" onerror="this.style.display='none'">
                        </div>
                        <p style="font-size:0.78rem;font-weight:600;margin-bottom:6px">${cat}</p>
                        <label style="background:#f4f6f4;border:1px solid #ddd;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:0.75rem;display:inline-block">
                            ⬆️ Choisir<input type="file" accept="image/*" style="display:none" onchange="previewParamCatImg(this,'${CAT_SLUGS[cat]}')">
                        </label>
                    </div>`).join('')}
                </div>
            </div>
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px;margin-bottom:16px">
                <h2 style="font-size:1rem;margin-bottom:6px">📢 Message de bienvenue (lancement)</h2>
                <p style="font-size:0.8rem;color:#888;margin-bottom:14px">Affiché dans une fenêtre avec un bouton « OK » : à chaque retour sur le site (après 30 min d'absence), à chaque connexion et à chaque création de compte. Vous écrivez seulement le texte.</p>
                <label style="display:flex;align-items:center;gap:8px;font-size:0.85rem;font-weight:600;margin-bottom:10px;cursor:pointer"><input type="checkbox" id="param-bienvenue-actif" ${paramMap.bienvenue_actif === '1' ? 'checked' : ''}> Afficher ce message aux visiteurs</label>
                <textarea id="param-bienvenue-msg" class="adm-input" rows="5" maxlength="600" style="width:100%;resize:vertical" placeholder="Ex : Merci d'être avec nous pour le lancement officiel de Kapmaket ! 🎉" oninput="document.getElementById('param-bienvenue-compteur').textContent=this.value.length+' / 600'">${echapperHtml(paramMap.bienvenue_message || '')}</textarea>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">
                    <span id="param-bienvenue-compteur" style="font-size:0.75rem;color:#888">${(paramMap.bienvenue_message || '').length} / 600</span>
                    <button type="button" onclick="apercuBienvenue()" style="background:#f0f7ff;color:#2f6fb5;border:1px solid #c5dcf5;padding:8px 14px;border-radius:8px;font-size:0.82rem;font-weight:600;cursor:pointer">👁️ Voir l'aperçu</button>
                </div>
                <p style="font-size:0.75rem;color:#888;margin-top:8px">Le texte s'affiche tel quel, retours à la ligne compris. Pensez à cliquer sur « Enregistrer les paramètres » ci-dessous.</p>
            </div>
            <button onclick="sauvegarderParametres()" style="background:#1F6B3A;color:white;border:none;padding:12px 20px;border-radius:9px;font-weight:700;cursor:pointer">💾 Enregistrer les paramètres</button>
            <p id="param-res" style="min-height:18px;font-size:0.82rem;margin-top:8px"></p>
        </div>

        <!-- RETOURS -->
        <div id="tab-retours" style="display:none">
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px">
                <h2 style="font-size:1rem;margin-bottom:14px">🔄 Demandes de retour (${(retours||[]).length})</h2>
                ${!(retours||[]).length ? '<p style="color:#888">Aucune demande de retour.</p>' :
                (retours||[]).map(r=>`<div style="background:#f8f8f8;border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid #eee">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
                        <div>
                            <div style="font-family:monospace;font-weight:700;color:#1F6B3A">${echapperHtml(r.code_commande)||'—'}</div>
                            <div style="font-size:0.78rem;color:#888;margin:4px 0">${new Date(r.created_at).toLocaleString('fr-FR')}</div>
                            <div style="font-size:0.85rem;margin-top:4px">${echapperHtml(r.motif)}</div>
                            <span style="display:inline-block;margin-top:6px;padding:3px 10px;border-radius:8px;font-size:0.72rem;font-weight:700;background:${r.statut==='en_attente'?'#fff8f0':r.statut==='traite'?'#f0fff4':'#fff0f0'};color:${r.statut==='en_attente'?'#E8792E':r.statut==='traite'?'#3FA66B':'#D9534F'}">${r.statut}</span>
                        </div>
                        <div style="display:flex;gap:6px">
                            <button onclick="changerStatutRetour('${r.id}','traite')" style="background:#f0fff4;color:#3FA66B;border:1px solid #b7f5c8;padding:6px 12px;border-radius:6px;font-size:0.78rem;cursor:pointer">✅ Traité</button>
                            <button onclick="changerStatutRetour('${r.id}','refuse')" style="background:#fff0f0;color:#D9534F;border:1px solid #fcc;padding:6px 12px;border-radius:6px;font-size:0.78rem;cursor:pointer">❌ Refuser</button>
                        </div>
                    </div>
                </div>`).join('')}
            </div>
        </div>

        <!-- CODES PROMO -->
        <div id="tab-promo" style="display:none">
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px;margin-bottom:16px">
                <h2 id="promo-form-title" style="font-size:1rem;margin-bottom:14px">🏷️ Créer un code promo</h2>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px">
                    <input id="promo-new-code" placeholder="CODE (ex: BIENVENUE10)" style="padding:10px;border-radius:8px;border:1px solid #ddd;text-transform:uppercase">
                    <select id="promo-new-type" style="padding:10px;border-radius:8px;border:1px solid #ddd">
                        <option value="pourcentage">Pourcentage (%)</option>
                        <option value="montant">Montant fixe (FCFA)</option>
                    </select>
                    <input id="promo-new-valeur" type="number" min="1" placeholder="Valeur" style="padding:10px;border-radius:8px;border:1px solid #ddd">
                    <input id="promo-new-min" type="number" min="0" placeholder="Achat minimum (FCFA, optionnel)" style="padding:10px;border-radius:8px;border:1px solid #ddd">
                    <input id="promo-new-max-usage" type="number" min="1" placeholder="Utilisations max (optionnel)" style="padding:10px;border-radius:8px;border:1px solid #ddd">
                    <input id="promo-new-expiration" type="date" style="padding:10px;border-radius:8px;border:1px solid #ddd">
                </div>
                <button id="btn-creer-promo" onclick="creerCodePromo()" style="background:#1F6B3A;color:white;border:none;padding:12px 20px;border-radius:9px;font-weight:700;cursor:pointer">➕ Créer le code</button>
                <button id="btn-annuler-edit-promo" onclick="annulerEditPromo()" style="display:none;background:#f4f6f4;color:#555;border:1px solid #ddd;padding:12px 20px;border-radius:9px;font-weight:600;cursor:pointer;margin-left:8px">Annuler</button>
                <p id="promo-new-res" style="min-height:18px;font-size:0.82rem;margin-top:8px"></p>
            </div>
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px">
                <h2 style="font-size:1rem;margin-bottom:14px">📋 Codes existants (${(codesPromo||[]).length})</h2>
                ${!(codesPromo||[]).length ? '<p style="color:#888">Aucun code promo créé.</p>' :
                (codesPromo||[]).map(c=>{
                    const expire = c.date_expiration ? new Date(c.date_expiration) : null;
                    const expiré = expire && expire < new Date();
                    return `<div style="background:#f8f8f8;border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
                        <div>
                            <div style="font-family:monospace;font-weight:700;color:#1F6B3A;font-size:0.95rem">${c.code}</div>
                            <div style="font-size:0.8rem;color:#555;margin-top:2px">${c.type==='pourcentage' ? c.valeur+'%' : fmt(c.valeur)+' FCFA'} de réduction${c.montant_min ? ` · dès ${fmt(c.montant_min)} FCFA d'achat` : ''}</div>
                            <div style="font-size:0.75rem;color:#888;margin-top:2px">
                                Utilisé ${c.usage_actuel||0}${c.usage_max ? ' / '+c.usage_max : ''} fois
                                ${expire ? ` · ${expiré?'expiré le':'expire le'} ${expire.toLocaleDateString('fr-FR')}` : ''}
                            </div>
                            <span style="display:inline-block;margin-top:6px;padding:3px 10px;border-radius:8px;font-size:0.72rem;font-weight:700;background:${c.actif && !expiré?'#f0fff4':'#fff0f0'};color:${c.actif && !expiré?'#3FA66B':'#D9534F'}">${c.actif && !expiré ? 'Actif' : (expiré ? 'Expiré' : 'Désactivé')}</span>
                        </div>
                        <div style="display:flex;gap:6px;flex-wrap:wrap">
                            <button onclick="chargerEditCodePromo('${c.id}')" style="background:#eef6ff;color:#1a5c9c;border:1px solid #cfe4fb;padding:6px 12px;border-radius:6px;font-size:0.78rem;cursor:pointer">✏️ Modifier</button>
                            ${expiré ? `<button onclick="reactiverCodePromo('${c.id}')" style="background:#eef6ff;color:#1a5c9c;border:1px solid #cfe4fb;padding:6px 12px;border-radius:6px;font-size:0.78rem;cursor:pointer;font-weight:600">🔄 Réactiver (+30j)</button>` : `<button onclick="toggleCodePromo('${c.id}',${!c.actif})" style="background:#fff8f0;color:#E8792E;border:1px solid #ffd8b0;padding:6px 12px;border-radius:6px;font-size:0.78rem;cursor:pointer">${c.actif?'⏸️ Désactiver':'▶️ Activer'}</button>`}
                            <button onclick="supprimerCodePromo('${c.id}')" style="background:#fff0f0;color:#D9534F;border:1px solid #fcc;padding:6px 12px;border-radius:6px;font-size:0.78rem;cursor:pointer">🗑️ Supprimer</button>
                        </div>
                    </div>`;
                }).join('')}
            </div>
        </div>

        <!-- VISITEURS -->
        <div id="tab-demande" style="display:none">
            <div id="demande-contenu" style="font-family:Inter,sans-serif"><p style="color:#888">Ouvrez l'onglet pour charger les statistiques…</p></div>
        </div>

        <div id="tab-visiteurs" style="display:none">
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px">
                <h2 style="font-size:1rem;margin-bottom:4px">👥 Visiteurs (${visiteurs.length})</h2>
                <p style="font-size:0.78rem;color:#888;margin-bottom:16px">Tracking anonyme (identifiant aléatoire) — un nom n'apparaît que si le visiteur a créé un compte.</p>
                ${!visiteurs.length ? '<p style="color:#888">Aucune activité enregistrée pour le moment.</p>' :
                visiteurs.map(v=>{
                    const nomAffiche = v.utilisateurs ? `👤 ${v.utilisateurs.nom}` : `🕶️ Anonyme #${v.session_id.slice(0,8)}`;
                    const dureeMin = Math.max(0, Math.round((new Date(v.derniere_activite) - new Date(v.premiere_visite))/60000));
                    return `<div style="background:#f8f8f8;border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid #eee;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
                        <div>
                            <div style="font-weight:700;font-size:0.9rem">${nomAffiche}</div>
                            <div style="font-size:0.78rem;color:#888;margin-top:2px">
                                Arrivé le ${new Date(v.premiere_visite).toLocaleString('fr-FR')} · dernière activité ${new Date(v.derniere_activite).toLocaleString('fr-FR')}
                            </div>
                            <div style="font-size:0.78rem;color:#555;margin-top:4px">
                                ${v.nb_visites} visite(s) · session ${dureeMin} min · ${v.stats.pages} page(s) vue(s) · ${v.stats.produits} produit(s) consulté(s) · ${v.stats.paniers} ajout(s) panier
                            </div>
                        </div>
                        <button onclick="voirTimelineVisiteur('${v.session_id}','${(nomAffiche+'').replace(/'/g,"")}')" style="background:#eef6ff;color:#1a5c9c;border:1px solid #cfe4fb;padding:8px 14px;border-radius:8px;font-size:0.8rem;font-weight:600;cursor:pointer;white-space:nowrap">📜 Chronologie</button>
                    </div>`;
                }).join('')}
            </div>
        </div>

        <!-- FLASH COMBO -->
        <div id="tab-combo" style="display:none">
            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px;margin-bottom:16px">
                <h2 id="combo-form-title" style="font-size:1rem;margin-bottom:4px">⚡ Créer un Flash Combo</h2>
                <p style="font-size:0.78rem;color:#888;margin-bottom:14px">1 produit principal + le client choisit ses accessoires parmi la liste ci-dessous, à un prix forfaitaire fixe.</p>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:12px">
                    <input id="combo-new-nom" placeholder="Nom de l'offre (ex: Kit Audio)" style="padding:10px;border-radius:8px;border:1px solid #ddd">
                    <select id="combo-new-principal" style="padding:10px;border-radius:8px;border:1px solid #ddd">
                        <option value="">— Produit principal —</option>
                        ${(prods||[]).map(p=>`<option value="${p.id}">${p.name} (${fmt(p.resale_price)} FCFA)</option>`).join('')}
                    </select>
                    <input id="combo-new-prix" type="number" min="1" placeholder="Prix forfaitaire du kit (FCFA)" style="padding:10px;border-radius:8px;border:1px solid #ddd">
                    <input id="combo-new-nbchoix" type="number" min="1" max="5" value="2" placeholder="Nb accessoires au choix" style="padding:10px;border-radius:8px;border:1px solid #ddd">
                    <input id="combo-new-debut" type="datetime-local" style="padding:10px;border-radius:8px;border:1px solid #ddd">
                    <input id="combo-new-fin" type="datetime-local" style="padding:10px;border-radius:8px;border:1px solid #ddd">
                </div>
                <p style="font-size:0.8rem;font-weight:600;margin-bottom:6px">Accessoires éligibles (le client en choisira parmi ceux cochés) :</p>
                <div style="max-height:220px;overflow-y:auto;border:1px solid #eee;border-radius:8px;padding:10px;margin-bottom:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px">
                    ${(prods||[]).map(p=>`<label style="display:flex;align-items:center;gap:6px;font-size:0.8rem;cursor:pointer">
                        <input type="checkbox" class="combo-new-choix-item" value="${p.id}"> ${p.name} <span style="color:#999">(${fmt(p.resale_price)} F)</span>
                    </label>`).join('')}
                </div>
                <button id="btn-creer-combo" onclick="creerOffreGroupee()" style="background:#1F6B3A;color:white;border:none;padding:12px 20px;border-radius:9px;font-weight:700;cursor:pointer">➕ Créer le Flash Combo</button>
                <button id="btn-annuler-edit-combo" onclick="annulerEditCombo()" style="display:none;background:#f4f6f4;color:#555;border:1px solid #ddd;padding:12px 20px;border-radius:9px;font-weight:600;cursor:pointer;margin-left:8px">Annuler</button>
                <p id="combo-new-res" style="min-height:18px;font-size:0.82rem;margin-top:8px"></p>
            </div>

            <div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:24px">
                <h2 style="font-size:1rem;margin-bottom:14px">📋 Combos existants (${offresGroupees.length})</h2>
                ${!offresGroupees.length ? '<p style="color:#888">Aucun Flash Combo créé.</p>' :
                offresGroupees.map(o=>{
                    const debut = o.date_debut ? new Date(o.date_debut) : null;
                    const fin = o.date_fin ? new Date(o.date_fin) : null;
                    const expire = fin && fin < new Date();
                    const nomPrincipal = o.products ? o.products.name : '(produit supprimé)';
                    return `<div style="background:#f8f8f8;border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid #eee">
                        <div style="display:flex;justify-content:space-between;align-items:start;flex-wrap:wrap;gap:10px">
                            <div>
                                <div style="font-weight:700;font-size:0.92rem">${o.nom} — <span style="color:#1F6B3A">${fmt(o.prix_ensemble)} FCFA</span></div>
                                <div style="font-size:0.8rem;color:#555;margin-top:2px">Principal : ${nomPrincipal} + ${o.nb_choix_requis} accessoire(s) au choix parmi ${(o.choix||[]).length}</div>
                                <div style="font-size:0.75rem;color:#888;margin-top:2px">
                                    ${debut ? 'du ' + debut.toLocaleString('fr-FR') : ''} ${fin ? "jusqu'au " + fin.toLocaleString('fr-FR') : ''}
                                </div>
                                <span style="display:inline-block;margin-top:6px;padding:3px 10px;border-radius:8px;font-size:0.72rem;font-weight:700;background:${o.actif && !expire?'#f0fff4':'#fff0f0'};color:${o.actif && !expire?'#3FA66B':'#D9534F'}">${o.actif && !expire ? 'Actif' : (expire ? 'Expiré' : 'Désactivé')}</span>
                            </div>
                            <div style="display:flex;gap:6px;flex-wrap:wrap">
                                <button onclick="chargerEditOffreGroupee('${o.id}')" style="background:#eef6ff;color:#1a5c9c;border:1px solid #cfe4fb;padding:6px 12px;border-radius:6px;font-size:0.78rem;cursor:pointer">✏️ Modifier</button>
                                ${expire ? `<button onclick="reactiverOffreGroupee('${o.id}')" style="background:#eef6ff;color:#1a5c9c;border:1px solid #cfe4fb;padding:6px 12px;border-radius:6px;font-size:0.78rem;cursor:pointer;font-weight:600">🔄 Réactiver (+7j)</button>` : `<button onclick="toggleOffreGroupee('${o.id}',${!o.actif})" style="background:#fff8f0;color:#E8792E;border:1px solid #ffd8b0;padding:6px 12px;border-radius:6px;font-size:0.78rem;cursor:pointer">${o.actif?'⏸️ Désactiver':'▶️ Activer'}</button>`}
                                <button onclick="supprimerOffreGroupee('${o.id}')" style="background:#fff0f0;color:#D9534F;border:1px solid #fcc;padding:6px 12px;border-radius:6px;font-size:0.78rem;cursor:pointer">🗑️ Supprimer</button>
                            </div>
                        </div>
                        <div style="margin-top:8px;font-size:0.76rem;color:#777">Pool : ${(o.choix||[]).map(c=>c ? c.name : '?').join(', ') || '—'}</div>
                    </div>`;
                }).join('')}
            </div>
        </div>

        </div>
    </div>
    <style>
        #admin-page { animation: admFadeIn 0.35s ease both; }
        @keyframes admFadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
        @media (prefers-reduced-motion: reduce) { #admin-page, #admin-page button { animation:none !important; transition:none !important; } }

        .adm-tab{background:rgba(255,255,255,0.12);color:rgba(255,255,255,0.92);border:none;padding:8px 14px;border-radius:20px;cursor:pointer;font-size:0.78rem;font-weight:600;font-family:Inter,sans-serif;transition:background 0.2s ease,transform 0.15s ease}
        .adm-tab:hover{background:rgba(255,255,255,0.22);transform:translateY(-1px)}
        .adm-tab.active{background:#fff;color:#1F6B3A;box-shadow:0 2px 8px rgba(0,0,0,0.15)}

        .adm-input{background:#f4f6f4;border:1.5px solid #eef0ee;padding:12px;color:#1a1a1a;border-radius:9px;font-size:0.9rem;width:100%;font-family:Inter,sans-serif;transition:border-color 0.15s ease,box-shadow 0.15s ease}
        .adm-input:focus{outline:none;border-color:#3FA66B;box-shadow:0 0 0 3px rgba(63,166,107,0.15);background:#fff}

        .mktg-prod-item:hover{background:#f4f6f4}

        /* Petit effet de survol cohérent sur tous les boutons de l'admin,
           sans casser les boutons qui définissent déjà leur propre animation. */
        #admin-page button{transition:transform 0.13s ease,filter 0.13s ease,box-shadow 0.13s ease}
        #admin-page button:hover{filter:brightness(1.05)}
        #admin-page button:active{transform:scale(0.97)}

        /* Ascenseur plus discret dans les listes déroulantes (accessoires,
           produits du popup) — l'ascenseur par défaut du navigateur jure
           avec le reste du design. */
        #admin-page *::-webkit-scrollbar{width:8px;height:8px}
        #admin-page *::-webkit-scrollbar-track{background:transparent}
        #admin-page *::-webkit-scrollbar-thumb{background:#cfe0d3;border-radius:8px}
        #admin-page *::-webkit-scrollbar-thumb:hover{background:#a9c7b1}

        /* Titres de section un peu plus affirmés, cohérents partout. */
        #admin-page h2{color:#16341f;letter-spacing:0.1px}

        /* Lignes de commande/produit qui se distinguent légèrement au survol
           dans les tableaux, pour mieux suivre où on regarde. */
        #cmds-admin-table tr:hover, #mktg-prod-liste label:hover{background:#f6f9f6 !important}
    </style>`;

    document.getElementById('mktg-type').onchange = function() {
        document.getElementById('mktg-slider-extra').style.display = this.value==='slider'?'flex':'none';
        document.getElementById('mktg-popup-extra').style.display = this.value==='popup'?'flex':'none';
    };

    showTab(adminTabActuel);
}

window.changerStatutRetour = async (id, statut) => {
    await adminAction('retours', 'update', { id, payload: { statut } });
    afficherPanneauAdmin();
};

let editingPromoId = null;
window.creerCodePromo = async () => {
    const res = document.getElementById('promo-new-res');
    const code = document.getElementById('promo-new-code').value.trim();
    const type = document.getElementById('promo-new-type').value;
    const valeur = document.getElementById('promo-new-valeur').value;
    const montant_min = document.getElementById('promo-new-min').value;
    const usage_max = document.getElementById('promo-new-max-usage').value;
    const date_expiration = document.getElementById('promo-new-expiration').value;
    if (!code || !valeur) { res.style.color = 'var(--danger)'; res.textContent = 'Code et valeur requis.'; return; }
    res.style.color = '#888'; res.textContent = editingPromoId ? 'Enregistrement...' : 'Création...';
    try {
        const payload = { code, type, valeur, montant_min, usage_max, date_expiration };
        if (editingPromoId) await adminAction('codes_promo', 'update', { id: editingPromoId, payload });
        else await adminAction('codes_promo', 'insert', { payload });
        editingPromoId = null;
        afficherPanneauAdmin();
    } catch (e) {
        res.style.color = '#D9534F'; res.textContent = '❌ ' + (e.message || 'Erreur');
    }
};

// Pré-remplit le formulaire du haut avec le code existant, comme pour
// l'édition d'un produit — modifier une valeur ou une date sans devoir
// supprimer puis tout recréer.
window.chargerEditCodePromo = (id) => {
    const c = (window._codesPromo || []).find(x => x.id === id); if (!c) return;
    editingPromoId = id;
    document.getElementById('promo-form-title').textContent = '✏️ Modifier le code promo';
    document.getElementById('promo-new-code').value = c.code;
    document.getElementById('promo-new-type').value = c.type;
    document.getElementById('promo-new-valeur').value = c.valeur;
    document.getElementById('promo-new-min').value = c.montant_min || '';
    document.getElementById('promo-new-max-usage').value = c.usage_max || '';
    document.getElementById('promo-new-expiration').value = c.date_expiration ? c.date_expiration.slice(0, 10) : '';
    document.getElementById('btn-creer-promo').textContent = '💾 Enregistrer les modifications';
    document.getElementById('btn-annuler-edit-promo').style.display = '';
    showTab('tab-promo'); window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.annulerEditPromo = () => {
    editingPromoId = null;
    ['promo-new-code','promo-new-valeur','promo-new-min','promo-new-max-usage','promo-new-expiration'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('promo-form-title').textContent = '🏷️ Créer un code promo';
    document.getElementById('btn-creer-promo').textContent = '➕ Créer le code';
    document.getElementById('btn-annuler-edit-promo').style.display = 'none';
};

window.toggleCodePromo = async (id, actif) => {
    await adminAction('codes_promo', 'update', { id, payload: { actif } });
    afficherPanneauAdmin();
};

// Relance un code promo expiré sans repasser par tout le formulaire de
// création : on garde exactement la même config (réduction, minimum
// d'achat, limite d'usage) et on repousse juste la date d'expiration.
window.reactiverCodePromo = async (id) => {
    const nouvelleExpiration = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    await adminAction('codes_promo', 'update', { id, payload: { actif: true, date_expiration: nouvelleExpiration } });
    notifier('✅ Code promo réactivé pour 30 jours de plus.', 'succes');
    afficherPanneauAdmin();
};

window.supprimerCodePromo = async (id) => {
    if (!confirm('Supprimer définitivement ce code promo ?')) return;
    await adminAction('codes_promo', 'delete', { id });
    afficherPanneauAdmin();
};

let editingComboId = null;
window.creerOffreGroupee = async () => {
    const res = document.getElementById('combo-new-res');
    const nom = document.getElementById('combo-new-nom').value.trim() || 'Flash Combo';
    const produit_principal_id = document.getElementById('combo-new-principal').value;
    const prix_ensemble = document.getElementById('combo-new-prix').value;
    const nb_choix_requis = document.getElementById('combo-new-nbchoix').value || 2;
    const date_debut = document.getElementById('combo-new-debut').value || null;
    const date_fin = document.getElementById('combo-new-fin').value || null;
    const choix_ids = Array.from(document.querySelectorAll('.combo-new-choix-item:checked')).map(el => el.value);

    if (!produit_principal_id || !prix_ensemble) { res.style.color = 'var(--danger)'; res.textContent = 'Produit principal et prix requis.'; return; }
    if (choix_ids.length < 2) { res.style.color = 'var(--danger)'; res.textContent = 'Coche au moins 2 accessoires éligibles.'; return; }
    if (choix_ids.includes(produit_principal_id)) { res.style.color = 'var(--danger)'; res.textContent = 'Le produit principal ne peut pas être aussi un accessoire.'; return; }

    res.style.color = '#888'; res.textContent = editingComboId ? 'Enregistrement...' : 'Création...';
    try {
        const payload = { nom, produit_principal_id, prix_ensemble, nb_choix_requis, date_debut, date_fin, choix_ids };
        if (editingComboId) await adminAction('offres_groupees', 'update', { id: editingComboId, payload });
        else await adminAction('offres_groupees', 'insert', { payload });
        editingComboId = null;
        afficherPanneauAdmin();
    } catch (e) {
        res.style.color = '#D9534F'; res.textContent = '❌ ' + (e.message || 'Erreur');
    }
};

// Pré-remplit le formulaire du haut avec le combo existant (nom, produit
// principal, prix, dates, ET les accessoires déjà cochés) — permet de
// changer n'importe quel réglage sans devoir tout supprimer et recréer.
window.chargerEditOffreGroupee = (id) => {
    const o = (window._offresGroupees || []).find(x => x.id === id); if (!o) return;
    editingComboId = id;
    document.getElementById('combo-form-title').textContent = '✏️ Modifier le Flash Combo';
    document.getElementById('combo-new-nom').value = o.nom || '';
    document.getElementById('combo-new-principal').value = o.produit_principal_id || o.produit_principal?.id || '';
    document.getElementById('combo-new-prix').value = o.prix_ensemble;
    document.getElementById('combo-new-nbchoix').value = o.nb_choix_requis || 2;
    document.getElementById('combo-new-debut').value = o.date_debut ? o.date_debut.slice(0, 16) : '';
    document.getElementById('combo-new-fin').value = o.date_fin ? o.date_fin.slice(0, 16) : '';
    const idsChoix = new Set((o.choix || []).map(p => p.id));
    document.querySelectorAll('.combo-new-choix-item').forEach(cb => { cb.checked = idsChoix.has(cb.value); });
    document.getElementById('btn-creer-combo').textContent = '💾 Enregistrer les modifications';
    document.getElementById('btn-annuler-edit-combo').style.display = '';
    showTab('tab-combo'); window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.annulerEditCombo = () => {
    editingComboId = null;
    ['combo-new-nom','combo-new-prix','combo-new-debut','combo-new-fin'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const sel = document.getElementById('combo-new-principal'); if (sel) sel.value = '';
    document.getElementById('combo-new-nbchoix').value = 2;
    document.querySelectorAll('.combo-new-choix-item').forEach(cb => { cb.checked = false; });
    document.getElementById('combo-form-title').textContent = '⚡ Créer un Flash Combo';
    document.getElementById('btn-creer-combo').textContent = '➕ Créer le Flash Combo';
    document.getElementById('btn-annuler-edit-combo').style.display = 'none';
};

window.toggleOffreGroupee = async (id, actif) => {
    await adminAction('offres_groupees', 'update', { id, payload: { actif } });
    afficherPanneauAdmin();
};

// Relance un Flash Combo expiré à l'identique (même produit principal, même
// pool d'accessoires, même prix) — juste une nouvelle fenêtre de 7 jours à
// partir de maintenant, sans repasser par tout le formulaire de création.
window.reactiverOffreGroupee = async (id) => {
    const maintenant = new Date().toISOString();
    const dansSeptJours = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    await adminAction('offres_groupees', 'update', { id, payload: { actif: true, date_debut: maintenant, date_fin: dansSeptJours } });
    notifier('✅ Flash Combo réactivé pour 7 jours.', 'succes');
    afficherPanneauAdmin();
};

window.supprimerOffreGroupee = async (id) => {
    if (!confirm('Supprimer définitivement ce Flash Combo ?')) return;
    await adminAction('offres_groupees', 'delete', { id });
    afficherPanneauAdmin();
};

const _iconesEvenements = {
    page_view: '📄', produit_vu: '🔍', produit_impression: '👀',
    panier_ajout: '🛒', recherche: '🔎', filtre_categorie: '📂', favori: '❤️'
};
const _libellesEvenements = {
    page_view: 'Page consultée', produit_vu: 'Fiche produit ouverte', produit_impression: 'Produit vu défiler',
    panier_ajout: 'Ajout au panier', recherche: 'Recherche', filtre_categorie: 'Filtre catégorie', favori: 'Favori'
};

window.voirTimelineVisiteur = async (sessionId, label) => {
    const el = document.createElement('div');
    el.className = 'modal-overlay';
    el.style.cssText = 'display:flex;z-index:6000;position:fixed;inset:0;background:rgba(0,0,0,0.6);align-items:center;justify-content:center;padding:16px';
    el.innerHTML = `<div style="background:white;border-radius:14px;max-width:520px;width:100%;max-height:80vh;overflow-y:auto;padding:22px;position:relative">
        <button onclick="this.closest('.modal-overlay').remove()" style="position:absolute;top:14px;right:14px;background:none;border:none;font-size:1.2rem;cursor:pointer">✕</button>
        <h2 style="font-size:1rem;margin-bottom:14px">📜 Chronologie — ${echapperHtml(label)}</h2>
        <div id="timeline-contenu" style="color:#888;font-size:0.85rem">Chargement...</div>
    </div>`;
    document.body.appendChild(el);

    try {
        const result = await adminAction('visiteurs', 'timeline', { payload: { session_id: sessionId } });
        const evenements = result.data || [];
        const contenu = el.querySelector('#timeline-contenu');
        if (!evenements.length) { contenu.textContent = 'Aucun événement enregistré.'; return; }
        contenu.innerHTML = evenements.map(e => {
            const heure = new Date(e.created_at).toLocaleString('fr-FR');
            let detail = e.cible || '';
            if (e.type === 'produit_vu' || e.type === 'produit_impression' || e.type === 'panier_ajout') {
                detail = (e.meta && e.meta.nom) ? e.meta.nom : detail;
                if (e.type === 'panier_ajout' && e.meta) detail += ` (×${e.meta.qty}, ${fmt(e.meta.prix)} FCFA)`;
            }
            if (e.type === 'page_view' && e.duree_secondes) detail += ` — ${e.duree_secondes}s`;
            return `<div style="display:flex;gap:10px;padding:9px 0;border-bottom:1px solid #f0f0f0">
                <span style="font-size:1.1rem">${_iconesEvenements[e.type]||'•'}</span>
                <div>
                    <div style="font-size:0.82rem;font-weight:600">${_libellesEvenements[e.type]||e.type}${detail ? ' — '+echapperHtml(detail) : ''}</div>
                    <div style="font-size:0.72rem;color:#999">${heure}</div>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        el.querySelector('#timeline-contenu').textContent = 'Erreur de chargement.';
    }
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
// Optimise les photos trop lourdes du stockage (le serveur les redimensionne, une par une). Les originaux sont conservés.
window.optimiserImagesSite = async () => {
    const btn = document.getElementById('btn-opt-img'), res = document.getElementById('opt-img-res');
    const barre = document.getElementById('opt-img-barre'), rempli = document.getElementById('opt-img-rempli');
    const mo = (o) => (o / 1048576).toFixed(1).replace('.', ',') + ' Mo';
    btn.disabled = true; res.style.color = '#888'; res.textContent = '⏳ Analyse du stockage…';
    try {
        const liste = await adminAction('images', 'lister');
        const lourdes = liste.lourdes || [], aMini = liste.aMiniaturiser || [];
        if (!lourdes.length && !aMini.length) {
            await adminAction('parametres', 'upsert', { payload: [{ cle: 'miniatures_actives', valeur: '1' }] });
            res.style.color = '#3FA66B'; res.textContent = `✅ Tes ${liste.total} images sont déjà légères et ont leur miniature.`; btn.disabled = false; return;
        }
        const poids = lourdes.reduce((t, f) => t + f.taille, 0);
        if (!confirm(`${lourdes.length} image(s) trop lourde(s) (${mo(poids)}) à réduire,\n${aMini.length} miniature(s) à créer pour les cartes, le slider et les tuiles.\n\nLancer maintenant ? Les originaux restent dans le dossier « _originaux ».`)) { res.textContent = ''; btn.disabled = false; return; }
        barre.style.display = 'block'; const total = lourdes.length + aMini.length; let fait = 0, avant = 0, apres = 0, reduites = 0, minis = 0, echecs = 0;
        const avance = () => { fait++; rempli.style.width = Math.round(100 * fait / Math.max(1, total)) + '%'; };
        for (const f of lourdes) {
            res.textContent = `⏳ Réduction des photos lourdes… ${fait + 1}/${total}`;
            try { const r = await adminAction('images', 'optimiser', { payload: { path: f.path } }); if (!r.ignore) { reduites++; avant += r.avant; apres += r.apres; } } catch (e) { echecs++; }
            avance();
        }
        for (const p of aMini) {
            res.textContent = `⏳ Création des miniatures… ${fait + 1}/${total}`;
            try { await adminAction('images', 'miniature', { payload: { path: p } }); minis++; } catch (e) { echecs++; }
            avance();
        }
        if (!echecs) await adminAction('parametres', 'upsert', { payload: [{ cle: 'miniatures_actives', valeur: '1' }] });   // actif seulement si tout est prêt
        res.style.color = echecs ? '#c77c00' : '#3FA66B';
        res.textContent = `${echecs ? '⚠️' : '✅'} ${reduites} photo(s) réduite(s) (${mo(avant)} → ${mo(apres)}), ${minis} miniature(s) créée(s)${echecs ? ` · ${echecs} échec(s) : relance pour réessayer (les miniatures ne seront activées qu'une fois tout terminé)` : ' · miniatures activées sur le site'}.`;
    } catch (e) { res.style.color = '#D9534F'; res.textContent = '❌ ' + e.message; }
    btn.disabled = false;
};

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
        rows.push(...bienvenueLignes(document.getElementById('param-bienvenue-actif').checked, document.getElementById('param-bienvenue-msg').value));
        for (const slug of Object.values(CAT_SLUGS)) {
            if (paramCatFiles[slug]) {
                const url = await uploadImage(paramCatFiles[slug]);
                rows.push({ cle: 'cat_img_' + slug, valeur: url });
            }
        }
        await adminAction('parametres', 'upsert', { payload: rows });
        paramCatFiles = {};
        res.style.color = '#3FA66B'; res.textContent = '✅ Paramètres enregistrés — visibles immédiatement sur le site.';
    } catch (e) {
        res.style.color = '#D9534F'; res.textContent = '❌ ' + e.message;
    }
};

function renderCmdsAdmin(data) {
    if (!data.length) return '<p style="color:#888;text-align:center;padding:20px">Aucune commande.</p>';
    window._resParCode = {}; data.forEach(r => window._resParCode[r.code] = r);
    return `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.8rem">
        <thead><tr>${['Code','Client','Zone','Total','Date & heure','Statut','Action',''].map(h=>`<th style="color:#888;font-weight:600;text-align:left;padding:8px 10px;border-bottom:2px solid #f0f0f0;font-size:0.72rem;text-transform:uppercase">${h}</th>`).join('')}</tr></thead>
        <tbody>${data.map(r=>`<tr style="border-bottom:1px solid #f8f8f8">
            <td style="padding:10px;font-family:monospace;color:#1F6B3A;font-weight:700">${r.code}</td>
            <td style="padding:10px">${echapperHtml(r.nom_client)}<br><span style="color:#888;font-size:0.72rem">${echapperHtml(r.telephone)}</span></td>
            <td style="padding:10px;color:#888;font-size:0.78rem">📍${r.zone_livraison||'—'}</td>
            <td style="padding:10px;font-weight:600">${fmt(r.total)} F</td>
            <td style="padding:10px;color:#888;font-size:0.75rem">${new Date(r.created_at).toLocaleDateString('fr-FR')} à ${new Date(r.created_at).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}</td>
            <td style="padding:10px"><span style="padding:3px 10px;border-radius:8px;font-size:0.7rem;font-weight:700;background:${r.statut==='en attente'?'#fff8f0':r.statut==='valide'?'#f0fff4':'#fff0f0'};color:${r.statut==='en attente'?'#E8792E':r.statut==='valide'?'#3FA66B':'#D9534F'}>${r.statut}</span>${r.paiement_a_verifier ? '<br><span style="color:#D9534F;font-size:0.7rem;font-weight:700">⚠️ paiement à vérifier</span>' : ''}${r.livreur_nom ? '<br><span style="color:#888;font-size:0.7rem">🚚 ' + echapperHtml(r.livreur_nom) + ({pris:' (a pris)',en_route:' (en route)',probleme:' (problème)',livree:' (livré)'}[r.etape_livraison] || '') + '</span>' : ''}</td>
            <td style="padding:10px"><select onchange="changerStatutAdmin('${r.id}',this.value)" style="background:#f4f6f4;color:#1a1a1a;border:1px solid #eef0ee;border-radius:6px;padding:5px;font-size:0.75rem">
                <option value="">Changer...</option>
                <option value="en attente">⏳ En attente</option>
                <option value="valide">✅ Validée</option>
                <option value="livre">🚚 Livrée</option>
                <option value="annule">❌ Annulée</option>
            </select></td>
            <td style="padding:10px"><button onclick="ouvrirDetailsCmdAdmin('${r.code}')" style="background:none;border:1px solid #eef0ee;padding:5px 10px;border-radius:6px;cursor:pointer;font-size:0.75rem">👁️ Détails</button></td>
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
            <div><strong>Client :</strong> ${echapperHtml(r.nom_client)} — ${echapperHtml(r.telephone)} ${!r.utilisateur_id ? '<span style="background:#f0f0f0;color:#888;padding:2px 8px;border-radius:6px;font-size:0.7rem;font-weight:700">🕶️ INVITÉ (sans compte)</span>' : ''}</div>
            <div><strong>Date :</strong> ${new Date(r.created_at).toLocaleDateString('fr-FR')} à ${new Date(r.created_at).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}</div>
            <div><strong>Zone :</strong> ${r.zone_livraison||'—'} ${r.frais_livraison?`(frais: ${fmt(r.frais_livraison)} F)`:''}</div>
            ${r.livraison_repere ? `<div><strong>Dépôt :</strong> ${echapperHtml(r.livraison_repere)}</div><div><strong>WhatsApp livraison :</strong> ${echapperHtml(r.livraison_whatsapp||'—')} ${r.livraison_whatsapp_ok?'✅ sur WhatsApp':'❌ pas sur WhatsApp'} · ${r.livraison_appels_ok?'📞 appels à toute heure':'📞 appels limités'}</div>` : ((CONFIG.ZONES_COUVERTES.includes(r.zone_livraison) && r.statut==='valide') ? '<div style="color:#c24c00"><strong>⏳ Infos de livraison non renseignées par le client</strong></div>' : '')}
            <div><strong>Statut :</strong> ${r.statut}${r.paye_le ? ` — payé le ${new Date(r.paye_le).toLocaleString('fr-FR')}` : ''}</div>
            ${r.transaction_id ? `<div><strong>Référence paiement :</strong> ${r.transaction_id}</div>` : ''}
            ${r.date_limite_retrait ? `<div style="color:#c24c00;font-weight:700">⏳ À retirer avant le ${new Date(r.date_limite_retrait).toLocaleDateString('fr-FR')}</div>` : ''}
        </div>
        ${r.visiteur_session_id ? `<button onclick="voirTimelineVisiteur('${r.visiteur_session_id}','${r.nom_client.replace(/'/g,"\\'")} (commande ${r.code})')" style="width:100%;margin-top:10px;background:#eef6ff;color:#1a5c9c;border:1px solid #cfe4fb;padding:9px;border-radius:8px;font-weight:600;cursor:pointer;font-size:0.82rem">📜 Voir son parcours sur le site avant l'achat</button>` : ''}
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid #eee">
            <strong style="font-size:0.85rem">Articles :</strong>
            ${(r.items||[]).map(i=>`<div style="display:flex;justify-content:space-between;font-size:0.85rem;padding:4px 0">
                <span>${i.name} ×${i.qty}</span><span>${fmt((i.prix||0)*(i.qty||1))} F</span>
            </div>`).join('')}
            <div style="display:flex;justify-content:space-between;font-weight:700;color:#1F6B3A;padding-top:8px;border-top:1px solid #eee;margin-top:6px">
                <span>TOTAL</span><span>${fmt(r.total)} F</span>
            </div>
        </div>
        <button onclick="telechargerFactureAdmin('${r.code}')" style="width:100%;margin-top:16px;background:#1F6B3A;color:white;border:none;padding:11px;border-radius:8px;font-weight:700;cursor:pointer">${estPaye?'🧾 Télécharger le reçu complet':'📄 Télécharger le suivi (non payé)'}</button>
    </div>`;
    document.body.appendChild(el);
};

window.telechargerFactureAdmin = async (code) => {
    try {
        const resp = await fetch(`/api/facture?code=${encodeURIComponent(code)}`, {
            headers: { 'Authorization': 'Bearer ' + (sessionStorage.getItem('cmkt_admin_token') || '') }
        });
        if (!resp.ok) { const j = await resp.json().catch(()=>({})); notifier('❌ ' + (j.error || 'Impossible de télécharger le reçu'), 'erreur'); return; }
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
        notifier('❌ Erreur lors du téléchargement : ' + (e.message || 'inconnue'), 'erreur');
    }
};

let adminTabActuel = 'tab-dash';
// ===== DEMANDE CLIENTS (admin) =====
// « Miroir de la demande » : ce que les clients demandent à l'assistant, tapent dans la recherche, regardent,
// mettent au panier et achètent. Les calculs sont faits côté serveur (api/_lib/demandesStats.js).
const DEMANDE_LIBELLES = {
    telephone: 'Téléphones', chargeur: 'Chargeurs', batterie: 'Batteries externes', ecouteurs: 'Écouteurs', casque: 'Casques',
    enceinte: 'Enceintes', accessoire: 'Accessoires', ordinateur: 'Ordinateurs', reseau: 'Réseau / Wi-Fi', gaming: 'Gaming',
    electronique: 'Électronique', promo: 'Promos', livraison: 'Livraison', paiement: 'Paiement', commande: 'Suivi de commande',
    retour: 'Retours', contact: 'Contact', autre: 'Autre'
};
const DEMANDE_NON_PRODUIT = ['livraison', 'paiement', 'commande', 'retour', 'contact', 'autre', 'promo'];
const demandeLib = k => DEMANDE_LIBELLES[k] || k;
function demandeVariation(v) {
    if (v === null || v === undefined) return '<span style="color:#3FA66B;font-size:0.72rem"> · nouveau</span>';
    if (v > 0) return `<span style="color:#3FA66B;font-size:0.72rem"> ▲ ${Number(v)} %</span>`;
    if (v < 0) return `<span style="color:#D9534F;font-size:0.72rem"> ▼ ${Math.abs(Number(v))} %</span>`;
    return '<span style="color:#888;font-size:0.72rem"> = stable</span>';
}
function demandeBarres(liste, libelle, couleur) {
    if (!liste || !liste.length) return '<p style="color:#888;font-size:0.82rem;margin:0">Pas encore de données.</p>';
    const max = Math.max(...liste.map(x => Number(x.n) || 0), 1);
    return liste.map(x => `<div style="margin-bottom:9px">
        <div style="display:flex;justify-content:space-between;gap:8px;font-size:0.82rem"><span>${echapperHtml(libelle(x))}</span><span style="white-space:nowrap"><b>${Number(x.n) || 0}</b>${x.variation !== undefined ? demandeVariation(x.variation) : ''}</span></div>
        <div style="background:#f0f0f0;border-radius:6px;height:8px;margin-top:3px"><div style="background:${couleur};width:${Math.max(4, Math.round((Number(x.n) || 0) / max * 100))}%;height:8px;border-radius:6px"></div></div></div>`).join('');
}
const demandeCarte = (titre, contenu, note) => `<div style="background:#fff;border-radius:16px;border:1px solid #eef0ee;box-shadow:0 2px 10px rgba(20,40,25,0.05);padding:20px;margin-bottom:16px">
    <h3 style="font-size:0.95rem;margin:0 0 4px">${titre}</h3>${note ? `<p style="font-size:0.75rem;color:#888;margin:0 0 12px">${note}</p>` : '<div style="height:10px"></div>'}${contenu}</div>`;
const demandeKpi = (valeur, libelle, extra) => `<div style="flex:1 1 130px;background:#f8faf8;border:1px solid #eef0ee;border-radius:12px;padding:12px">
    <div style="font-size:1.35rem;font-weight:800">${valeur}</div><div style="font-size:0.74rem;color:#666">${libelle}</div>${extra || ''}</div>`;
const demandeVar = (n, avant) => (avant > 0 ? Math.round((n - avant) / avant * 100) : null);

function rendreDemande(s) {
    const T = s.totaux || {}, A = s.assistant || {}, W = s.site || {};
    const peuDeDonnees = (T.questions || 0) < 20;

    // ---- À retenir : des phrases simples tirées des chiffres ----
    const points = [];
    const topProduit = (A.intentions || []).find(x => !DEMANDE_NON_PRODUIT.includes(x.intention));
    if (topProduit) points.push(`Le plus demandé à l'assistant : <b>${echapperHtml(demandeLib(topProduit.intention))}</b> (${topProduit.n} fois${topProduit.variation === null ? ', nouveau' : topProduit.variation > 0 ? ', en hausse de ' + topProduit.variation + ' %' : topProduit.variation < 0 ? ', en baisse de ' + Math.abs(topProduit.variation) + ' %' : ''}).`);
    if ((A.sans_produit || []).length) points.push(`💡 Demandes <b>sans produit chez vous</b> : ${A.sans_produit.slice(0, 3).map(x => '<b>' + echapperHtml(x.terme) + '</b> (×' + x.n + ')').join(', ')} — à étudier pour votre prochain stock.`);
    const topSite = (W.produits || [])[0];
    if (topSite) points.push(`Produit qui attire le plus : <b>${echapperHtml(topSite.nom)}</b> (${topSite.vues} vues, ${topSite.paniers} ajouts au panier, ${topSite.vendus} vendu(s)).`);
    const regardes = (W.produits || []).filter(p => p.vues >= 10 && p.vendus === 0).slice(0, 2);
    if (regardes.length) points.push(`👀 Beaucoup regardé mais jamais acheté : ${regardes.map(p => '<b>' + echapperHtml(p.nom) + '</b>').join(', ')} — prix, photos ou description à revoir ?`);
    const bud = (A.budgets || [])[0];
    if (bud && bud.mediane) points.push(`Budget typique pour <b>${echapperHtml(demandeLib(bud.intention))}</b> : environ <b>${fmt(bud.mediane)} FCFA</b> (${bud.n} demande(s)).`);
    const frein = (A.intentions || []).filter(x => ['livraison', 'paiement'].includes(x.intention) && x.n >= 5);
    if (frein.length) points.push(`Beaucoup de questions sur <b>${frein.map(x => echapperHtml(demandeLib(x.intention)).toLowerCase()).join(' et ')}</b> : c'est peut-être à mieux expliquer sur le site.`);
    if (peuDeDonnees) points.unshift(`⚠️ Seulement ${T.questions || 0} question(s) à l'assistant sur la période : les tendances sont <b>indicatives</b>. Elles deviennent fiables après quelques semaines.`);

    // ---- Heures ----
    const heures = s.heures || new Array(24).fill(0);
    const maxH = Math.max(...heures, 1);
    const colonnes = heures.map((n, h) => `<div style="flex:1;text-align:center"><div style="height:60px;display:flex;align-items:flex-end"><div style="width:100%;background:${n === maxH && n > 0 ? '#E8792E' : '#9fd4b5'};height:${Math.max(2, Math.round(n / maxH * 100))}%;border-radius:3px 3px 0 0" title="${h} h : ${n}"></div></div><div style="font-size:0.58rem;color:#888">${h % 3 === 0 ? h : ''}</div></div>`).join('');

    const lignesProduits = (W.produits || []).map(p => `<tr style="border-top:1px solid #f0f0f0">
        <td style="padding:7px 4px;font-size:0.82rem">${echapperHtml(p.nom)}${p.vendus >= 3 ? ' <span title="Se vend bien">💰</span>' : ''}${p.vues >= 10 && p.vendus === 0 ? ' <span title="Beaucoup regardé, jamais acheté">👀</span>' : ''}</td>
        <td style="text-align:right;padding:7px 4px;font-size:0.82rem">${p.vues}${demandeVariation(p.variation)}</td>
        <td style="text-align:right;padding:7px 4px;font-size:0.82rem">${p.paniers}</td>
        <td style="text-align:right;padding:7px 4px;font-size:0.82rem;font-weight:700">${p.vendus}</td></tr>`).join('');

    const bouton = (j) => `<button onclick="chargerDemande(${j})" style="padding:7px 14px;border-radius:20px;border:1.5px solid ${s.jours === j ? '#0E7C4A' : '#ddd'};background:${s.jours === j ? '#0E7C4A' : '#fff'};color:${s.jours === j ? '#fff' : '#333'};font-weight:700;font-size:0.78rem;cursor:pointer">${j} jours</button>`;

    const recentes = (s.questions_recentes || []).map(q => `<div style="padding:7px 0;border-top:1px solid #f0f0f0;font-size:0.8rem">
        <span style="color:#888">${new Date(q.date).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span> — « ${echapperHtml(q.question || '')} »
        ${q.intention ? `<span style="background:#eef6f0;border-radius:8px;padding:1px 7px;font-size:0.7rem;margin-left:4px">${echapperHtml(demandeLib(q.intention))}</span>` : ''}
        ${q.trouve === false ? '<span style="color:#E8792E;font-size:0.72rem;margin-left:4px">❌ rien en catalogue</span>' : ''}</div>`).join('');

    return `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px">
            <div><h2 style="font-size:1.05rem;margin:0">📈 Ce que veulent vos clients</h2>
            <p style="font-size:0.75rem;color:#888;margin:2px 0 0">Données anonymes (aucun nom ni numéro n'est enregistré). Comparaison avec la période précédente de même durée.</p></div>
            <div style="display:flex;gap:6px">${bouton(7)}${bouton(30)}${bouton(90)}</div></div>
        ${s.avertissement ? `<div style="background:#fff8f0;border:1px solid #f3c99d;border-radius:12px;padding:12px;margin-bottom:14px;font-size:0.82rem">⚠️ ${echapperHtml(s.avertissement)}</div>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px">
            ${demandeKpi(T.questions || 0, 'questions à l\'assistant', demandeVariation(demandeVar(T.questions || 0, T.questions_avant || 0)))}
            ${demandeKpi(T.personnes || 0, 'personnes différentes')}
            ${demandeKpi(T.recherches_barre || 0, 'recherches (barre du site)')}
            ${demandeKpi(T.vues_produits || 0, 'fiches produit ouvertes')}
            ${demandeKpi(T.ajouts_panier || 0, 'ajouts au panier')}
            ${demandeKpi(T.commandes_payees || 0, 'commandes payées')}
            ${demandeKpi((T.part_whatsapp || 0) + ' %', 'renvoyés vers WhatsApp')}</div>
        ${demandeCarte('🎯 À retenir', points.length ? '<ul style="margin:0;padding-left:18px;font-size:0.85rem;line-height:1.6">' + points.map(p => '<li>' + p + '</li>').join('') + '</ul>' : '<p style="color:#888;font-size:0.82rem;margin:0">Pas encore assez de données.</p>')}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px">
            <div>${demandeCarte('💬 Ce qu\'ils demandent à l\'assistant', demandeBarres(A.intentions, x => demandeLib(x.intention), '#0E7C4A'), 'Par sujet, sur la période.')}
                 ${demandeCarte('🔎 Produits cherchés (assistant)', demandeBarres(A.recherches, x => x.terme, '#2f80ed'), 'Mots-clés relevés par l\'assistant.')}
                 ${demandeCarte('🧾 Budgets cités', (A.budgets || []).length ? '<table style="width:100%;border-collapse:collapse">' + A.budgets.map(b => `<tr style="border-top:1px solid #f0f0f0"><td style="padding:7px 4px;font-size:0.82rem">${echapperHtml(demandeLib(b.intention))} <span style="color:#888">(${b.n})</span></td><td style="text-align:right;font-size:0.82rem"><b>${fmt(b.mediane)}</b> FCFA <span style="color:#888">(de ${fmt(b.min)} à ${fmt(b.max)})</span></td></tr>`).join('') + '</table>' : '<p style="color:#888;font-size:0.82rem;margin:0">Pas encore de budget cité.</p>', 'Médiane = la valeur « du milieu ».')}
                 ${demandeCarte('❌ Demandes sans produit chez vous', demandeBarres(A.sans_produit, x => x.terme, '#E8792E'), 'Ce que des clients cherchent et que votre catalogue n\'a pas : des idées de stock.')}</div>
            <div>${demandeCarte('⌨️ Recherches dans la barre du site', demandeBarres(W.recherches_barre, x => x.terme, '#2f80ed'))}
                 ${demandeCarte('🗂️ Catégories les plus ouvertes', demandeBarres(W.categories, x => x.categorie, '#9b59b6'))}
                 ${demandeCarte('⏰ Heures des questions (heure de Douala)', `<div style="display:flex;gap:2px">${colonnes}</div>`)}</div></div>
        ${demandeCarte('🛍️ Produits : regardés, mis au panier, vendus', lignesProduits ? `<table style="width:100%;border-collapse:collapse"><tr style="font-size:0.72rem;color:#888"><th style="text-align:left;padding:4px">Produit</th><th style="text-align:right;padding:4px">Vues</th><th style="text-align:right;padding:4px">Paniers</th><th style="text-align:right;padding:4px">Vendus</th></tr>${lignesProduits}</table>` : '<p style="color:#888;font-size:0.82rem;margin:0">Pas encore de données.</p>', '💰 se vend bien · 👀 beaucoup regardé mais jamais acheté.')}
        ${demandeCarte('🗒️ Dernières questions (telles qu\'écrites par les clients)', recentes || '<p style="color:#888;font-size:0.82rem;margin:0">Aucune question pour le moment.</p>', 'Numéros, e-mails et codes de commande sont masqués. À lire pour comprendre les mots des clients.')}`;
}

window.chargerDemande = async (jours) => {
    const zone = document.getElementById('demande-contenu');
    if (!zone) return;
    zone.innerHTML = '<p style="color:#888">Chargement des statistiques…</p>';
    try {
        const stats = await adminAction('demandes', 'stats', { payload: { jours: jours || 30 } });
        zone.innerHTML = rendreDemande(stats);
    } catch (e) {
        zone.innerHTML = `<div style="background:#fff0f0;border-radius:12px;padding:14px;color:#D9534F;font-size:0.85rem">❌ ${echapperHtml(e.message || 'Erreur')}</div>`;
    }
};
// ===== FIN DEMANDE CLIENTS =====

window.showTab = id => {
    adminTabActuel = id;
    ['tab-dash','tab-prods','tab-cmds','tab-users','tab-avis','tab-mktg','tab-param','tab-retours','tab-promo','tab-visiteurs','tab-demande','tab-combo'].forEach(t=>{
        const el=document.getElementById(t); if(el) el.style.display=t===id?'block':'none';
    });
    ['tb-dash','tb-prods','tb-cmds','tb-users','tb-avis','tb-mktg','tb-param','tb-retours','tb-promo','tb-visiteurs','tb-demande','tb-combo'].forEach(b=>{
        const el=document.getElementById(b); if(el) el.classList.toggle('active', b==='tb-'+id.replace('tab-',''));
    });
};

window.filtrerCmdsAdmin = q => {
    const data = window._res.filter(r=>r.code.toLowerCase().includes(q.toLowerCase())||r.nom_client.toLowerCase().includes(q.toLowerCase()));
    document.getElementById('cmds-admin-table').innerHTML = renderCmdsAdmin(data);
};

// Échappe une valeur pour un champ CSV : entourée de guillemets dès qu'elle
// contient une virgule, un guillemet ou un retour à la ligne (sinon Excel
// découperait la ligne au mauvais endroit).
function champCsv(v) {
    const s = String(v ?? '');
    return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

window.exporterCommandesCsv = () => {
    const q = document.getElementById('cmd-search')?.value || '';
    const data = q ? window._res.filter(r=>r.code.toLowerCase().includes(q.toLowerCase())||r.nom_client.toLowerCase().includes(q.toLowerCase())) : window._res;
    if (!data.length) { notifier('😕 Aucune commande à exporter.', 'info'); return; }

    const entetes = ['Code','Date','Client','Téléphone','Compte/Invité','Zone de livraison','Statut','Articles','Sous-total (F)','Réduction (F)','Code promo','Frais livraison (F)','Total (F)'];
    const lignes = data.map(r => {
        const sousTotal = (r.items||[]).reduce((s,i)=>s+(i.prix||0)*(i.qty||1), 0);
        const articles = (r.items||[]).map(i => `${i.name} x${i.qty}`).join(' | ');
        return [
            r.code,
            new Date(r.created_at).toLocaleString('fr-FR'),
            r.nom_client || '',
            r.telephone || '',
            r.utilisateur_id ? 'Compte' : 'Invité',
            r.zone_livraison || '',
            r.statut,
            articles,
            sousTotal,
            r.reduction || 0,
            r.code_promo || '',
            r.frais_livraison || 0,
            r.total
        ].map(champCsv).join(',');
    });
    // Le BOM UTF-8 (\uFEFF) est indispensable : sans lui, Excel affiche les
    // accents français comme des caractères corrompus à l'ouverture du CSV.
    const csv = '\uFEFF' + entetes.join(',') + '\n' + lignes.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `commandes_kapmaket_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    notifier(`✅ ${data.length} commande(s) exportée(s).`, 'succes');
};

window.changerStatutAdmin = async (id, statut) => {
    if(!statut)return;
    await adminAction('reservations','update',{id,payload:{statut}});
    afficherPanneauAdmin();
};

window.validerAvisAdmin = async id => { await adminAction('avis','update',{id,payload:{valide:true}}); afficherPanneauAdmin(); };
window.supprimerAvisAdmin = async id => { if(!confirm('Supprimer ?'))return; await adminAction('avis','delete',{id}); afficherPanneauAdmin(); };

window.adminResetMdp = async (userId, nom, email) => {
    if (!email) { notifier(`❌ ${nom} n'a pas d'email enregistré, impossible d'envoyer un lien de réinitialisation.`, 'erreur'); return; }
    if (!confirm(`Envoyer un lien de réinitialisation de mot de passe à ${nom} (${email}) ?`)) return;
    try {
        await window.fbSendPasswordResetEmail(window.firebaseAuth, email);
        notifier(`✅ Email de réinitialisation envoyé à ${email} (pense à lui dire de vérifier ses spams si rien n'arrive).`, 'succes');
    } catch (e) {
        notifier('❌ ' + traduireErreurFirebase(e), 'erreur');
    }
};
window.adminSupprimerUtilisateur = async (userId, nom) => {
    if (!confirm(`Supprimer définitivement le profil de ${nom} ?\n\nSon profil et son historique seront détachés (irréversible). Il te restera une dernière étape manuelle pour bannir aussi son compte de connexion.`)) return;
    try {
        const r = await adminAction('utilisateurs', 'delete', { id: userId });
        afficherPanneauAdmin();
        const identifiant = r.email || r.firebase_uid || '(voir Firebase)';
        notifier(`✅ Profil de ${nom} supprimé.\n\nPour finir, supprime aussi son compte de connexion dans la console Firebase :\nAuthentication → Users → cherche "${identifiant}" → icône poubelle.`, 'succes');
    } catch (e) {
        notifier('❌ ' + e.message, 'erreur');
    }
};

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
    majAlertePhoto();   // vérifie si la photo choisie existe déjà sur le site
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
        x.style.cssText = 'position:absolute;top:-6px;right:-6px;background:#D9534F;color:white;border:none;border-radius:50%;width:16px;height:16px;font-size:0.6rem;cursor:pointer;line-height:1;padding:0';
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

// ===== ANTI-DOUBLONS (ajout de produits dans le panneau admin) =====
// Avertit dès la saisie du nom, demande confirmation avant l'ajout, et le serveur contrôle aussi (voir api/admin-action.js).
const doublonsPour = (nom, ignorerId) => (window.CMKT_DOUBLONS ? window.CMKT_DOUBLONS.trouverDoublons(nom, window._prods || [], { ignorerId }) : []);
const phraseProduit = (p) => `${p.name} · ${p.category || '—'} · ${p.resale_price != null ? fmt(p.resale_price) + ' FCFA' : '—'} · ${p.quantity === 0 ? 'rupture' : 'stock ' + (p.quantity != null ? p.quantity : '—')}`;

function majAlerteDoublon() {
    const zone = document.getElementById('p-doublon'), champ = document.getElementById('p-name');
    if (!zone || !champ) return;
    const d = doublonsPour(champ.value, typeof editingId !== 'undefined' ? editingId : null);
    if (!d.length) { zone.style.display = 'none'; zone.replaceChildren(); return; }
    const identique = d[0].niveau === 'identique';
    zone.style.display = 'block'; zone.className = 'doublon-alerte' + (identique ? ' doublon-rouge' : '');
    const titre = document.createElement('div'); titre.className = 'doublon-titre';
    titre.textContent = identique ? '⛔ Cet article est déjà sur le site' : '⚠️ Article très ressemblant déjà sur le site : vérifie que c’est bien un autre produit';
    zone.replaceChildren(titre);
    d.slice(0, 3).forEach(x => {
        const l = document.createElement('div'); l.className = 'doublon-ligne';
        l.append(document.createTextNode('« ' + phraseProduit(x.produit) + ' »'));
        if (x.produit.id != null) { const b = document.createElement('button'); b.type = 'button'; b.className = 'doublon-btn'; b.textContent = '✏️ Ouvrir ce produit'; b.onclick = () => chargerEditProduit(x.produit.id); l.append(b); }
        zone.append(l);
    });
}

// Demande confirmation si le nom ressemble à un produit déjà présent. Renvoie true si on peut ajouter quand même.
function confirmerDoublon(nom, ignorerId, doublons) {
    const d = doublons || doublonsPour(nom, ignorerId);
    if (!d.length) return Promise.resolve(true);
    return new Promise(fini => {
        const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
        const ov = el('div', 'photo-overlay'); ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
        const feuille = el('div', 'photo-sheet'), corps = el('div', 'photo-body');
        const identique = d[0].niveau === 'identique';
        const fermer = (reponse) => { document.removeEventListener('keydown', surTouche); ov.remove(); fini(reponse); };
        function surTouche(e) { if (e.key === 'Escape') fermer(false); }
        document.addEventListener('keydown', surTouche);
        const niv = d[0].niveau;
        corps.append(el('h3', null, niv === 'identique' ? '⛔ Cet article existe déjà' : niv === 'photo' ? '📷 Cette photo existe déjà sur le site' : '⚠️ Article très ressemblant déjà présent'),
            el('p', 'photo-note', niv === 'identique' ? 'Un produit identique est déjà sur le site :' : niv === 'photo' ? 'Un produit du site utilise une photo identique ou très ressemblante :' : 'Ce produit ressemble à ceci, déjà sur le site :'));
        d.slice(0, 3).forEach(x => {
            const l = el('div', 'doublon-ligne', '« ' + phraseProduit(x.produit) + ' »' + (x.niveau === 'photo' ? ' — photo ' + (x.distance <= window.CMKT_DOUBLONS.SEUIL_PHOTO_IDENTIQUE ? 'quasi identique' : 'ressemblante') : ''));
            if (x.produit.id != null) { const b = el('button', 'doublon-btn', '✏️ Ouvrir'); b.type = 'button'; b.onclick = () => { fermer(false); chargerEditProduit(x.produit.id); }; l.append(b); }
            corps.append(l);
        });
        corps.append(el('p', 'photo-note', `Ajouter quand même « ${nom} » ?`));
        const rang = el('div', 'photo-choix');
        const non = el('button', 'photo-btn photo-btn-main', 'Ne pas ajouter'); non.type = 'button'; non.onclick = () => fermer(false);
        const oui = el('button', 'photo-btn', 'Ajouter quand même (c’est un autre produit)'); oui.type = 'button'; oui.onclick = () => fermer(true);
        rang.append(non, oui); corps.append(rang);
        feuille.append(corps); ov.append(feuille); document.body.append(ov); non.focus();
    });
}

// Ajoute le produit ; si le serveur trouve un doublon que la liste affichée ne montrait pas (autre onglet, ajout très récent), redemande confirmation.
async function insererProduitAvecControle(payload, forcerDeja) {
    try { return await adminAction('products', 'insert', { payload, forcer: forcerDeja === true }); }
    catch (e) {
        if (e.code === 'doublon' && !forcerDeja) {
            const d = (e.doublons || []).map(x => ({ produit: x, niveau: x.niveau }));
            if (await confirmerDoublon(payload.name, null, d)) return adminAction('products', 'insert', { payload, forcer: true });
            const annule = new Error('Ajout annulé : cet article existe déjà.'); annule.annule = true; throw annule;
        }
        throw e;
    }
}

// Mode lot : signale, fiche par fiche, les articles déjà sur le site ou déjà présents ailleurs dans le même lot.
function marquerDoublonsLot() {
    if (!window.CMKT_DOUBLONS) return;
    const champs = [];
    for (let i = 0; document.getElementById('ia-lot-name-' + i); i++) champs.push(document.getElementById('ia-lot-name-' + i));
    champs.forEach((champ, i) => {
        let note = champ.parentElement.querySelector('.doublon-note');
        if (!note) { note = document.createElement('div'); note.className = 'doublon-note'; champ.insertAdjacentElement('afterend', note); }
        const d = doublonsPour(champ.value, null);
        let texte = '';
        if (d.length) texte = (d[0].niveau === 'identique' ? '⛔ Déjà sur le site : « ' : '⚠️ Ressemble à un produit du site : « ') + d[0].produit.name + ' »';
        else for (let j = 0; j < i; j++) { if (window.CMKT_DOUBLONS.comparer(champ.value, champs[j].value)) { texte = `⚠️ Ressemble à la fiche n°${j + 1} de ce lot`; break; } }
        note.textContent = texte; note.style.display = texte ? 'block' : 'none';
    });
}
document.addEventListener('input', (e) => {
    const id = e.target && e.target.id;
    if (id === 'p-name') { clearTimeout(window._tDoublon); window._tDoublon = setTimeout(majAlerteDoublon, 250); }
    else if (id && id.startsWith('ia-lot-name-')) { clearTimeout(window._tDoublonLot); window._tDoublonLot = setTimeout(marquerDoublonsLot, 250); }
});

// ===== ANTI-DOUBLONS : PHOTOS ET SCAN DU CATALOGUE =====
// Empreinte visuelle d'une image (dHash 16×16) : deux photos du même article, même recompressées ou redimensionnées,
// ont des empreintes presque identiques. Calculée dans le navigateur et gardée en mémoire (par adresse de photo).
const CLE_EMPREINTES = 'cmkt_empreintes_v1', CLE_IGNORES = 'cmkt_doublons_ignores_v1';
window._empreintes = (() => { try { return JSON.parse(localStorage.getItem(CLE_EMPREINTES) || '{}'); } catch (e) { return {}; } })();
window._empreintesEchecs = new Set();
window._jetonPhoto = 0;
function sauverEmpreintes() {
    try {
        const cles = Object.keys(window._empreintes);
        if (cles.length > 800) cles.slice(0, cles.length - 800).forEach(k => delete window._empreintes[k]);
        localStorage.setItem(CLE_EMPREINTES, JSON.stringify(window._empreintes));
    } catch (e) {}
}
function empreinteImage(img) {
    const reduire = (src, l, h) => { const c = document.createElement('canvas'); c.width = l; c.height = h; const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, l, h); x.drawImage(src, 0, 0, l, h); return c; };
    const petit = reduire(reduire(img, 136, 128), 17, 16);   // réduction en 2 temps : moyenne plus fidèle
    const d = petit.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, 17, 16).data;
    const g = (i, j) => { const k = (j * 17 + i) * 4; return 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]; };
    let bits = '';
    for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) bits += g(i, j) > g(i + 1, j) ? '1' : '0';
    let hex = ''; for (let k = 0; k < 256; k += 4) hex += parseInt(bits.slice(k, k + 4), 2).toString(16);
    return hex;
}
function chargerImageCors(url) {
    return new Promise((ok, ko) => {
        const i = new Image(); i.crossOrigin = 'anonymous';
        const t = setTimeout(() => ko(new Error('délai')), 15000);
        i.onload = () => { clearTimeout(t); ok(i); }; i.onerror = () => { clearTimeout(t); ko(new Error('image')); };
        i.src = url;
    });
}
async function empreinteUrl(url) {
    if (!url) return null;
    if (window._empreintes[url]) return window._empreintes[url];
    if (window._empreintesEchecs.has(url)) return null;
    try { const h = empreinteImage(await chargerImageCors(url)); window._empreintes[url] = h; return h; }
    catch (e) { window._empreintesEchecs.add(url); return null; }
}
async function empreinteFichier(fichier) {
    const url = URL.createObjectURL(fichier);
    try {
        const img = await new Promise((ok, ko) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ko(new Error('image')); im.src = url; });
        return empreinteImage(img);
    } catch (e) { return null; } finally { URL.revokeObjectURL(url); }
}
// Calcule les empreintes manquantes des photos du catalogue (6 à la fois). `progres(fait, total)` alimente la barre d'avancement.
async function empreintesCatalogue(progres) {
    const urls = [...new Set((window._prods || []).map(p => String(p.image_url || '').trim()).filter(Boolean))];
    const file = urls.slice(); let fait = 0;
    const travailleur = async () => { while (file.length) { await empreinteUrl(file.shift()); fait++; if (progres) progres(fait, urls.length); } };
    await Promise.all(Array.from({ length: 6 }, travailleur));
    sauverEmpreintes();
    return window._empreintes;
}
// Produits du site dont la photo ressemble à ce fichier (meilleure approximation d'abord).
async function doublonsPhoto(fichier, ignorerId) {
    if (!fichier || !window.CMKT_DOUBLONS) return [];
    try {
        const h = await empreinteFichier(fichier); if (!h) return [];
        await Promise.race([empreintesCatalogue(), new Promise(ok => setTimeout(ok, 20000))]);   // au pire, on continue sans la comparaison
        const trouves = [];
        (window._prods || []).forEach(p => {
            if (ignorerId != null && p.id === ignorerId) return;
            const hp = window._empreintes[String(p.image_url || '').trim()]; if (!hp) return;
            const dist = window.CMKT_DOUBLONS.distanceEmpreintes(h, hp);
            if (dist <= window.CMKT_DOUBLONS.SEUIL_PHOTO_PROCHE) trouves.push({ produit: p, niveau: 'photo', distance: dist });
        });
        return trouves.sort((a, b) => a.distance - b.distance).slice(0, 3);
    } catch (e) { return []; }
}
// Encadré sous le champ photo du formulaire : « cette photo ressemble à celle de … »
async function majAlertePhoto() {
    const zone = document.getElementById('p-doublon-photo'); if (!zone) return;
    const jeton = ++window._jetonPhoto;
    if (!selectedFilesAll.length) { zone.style.display = 'none'; zone.replaceChildren(); return; }
    zone.className = 'doublon-alerte'; zone.style.display = 'block'; zone.textContent = '🔎 Vérification de la photo…';
    const resultats = (await Promise.all(selectedFilesAll.map(f => doublonsPhoto(f, editingId)))).flat();
    if (jeton !== window._jetonPhoto) return;   // la sélection a changé entre-temps
    const liste = resultats.filter((x, k, t) => t.findIndex(y => y.produit.id === x.produit.id) === k).slice(0, 3);
    if (!liste.length) { zone.style.display = 'none'; zone.replaceChildren(); return; }
    const identique = liste[0].distance <= window.CMKT_DOUBLONS.SEUIL_PHOTO_IDENTIQUE;
    zone.className = 'doublon-alerte' + (identique ? ' doublon-rouge' : '');
    const titre = document.createElement('div'); titre.className = 'doublon-titre';
    titre.textContent = identique ? '📷 Cette photo est déjà utilisée sur le site' : '📷 Cette photo ressemble à celle d’un produit déjà sur le site';
    zone.replaceChildren(titre);
    liste.forEach(x => {
        const l = document.createElement('div'); l.className = 'doublon-ligne'; l.append(document.createTextNode('« ' + phraseProduit(x.produit) + ' »'));
        if (x.produit.id != null) { const b = document.createElement('button'); b.type = 'button'; b.className = 'doublon-btn'; b.textContent = '✏️ Ouvrir ce produit'; b.onclick = () => chargerEditProduit(x.produit.id); l.append(b); }
        zone.append(l);
    });
}
// Mode lot : signale les photos déjà sur le site ou en double dans le même lot.
async function marquerDoublonsPhotosLot() {
    const fichiers = window._iaLotFichiers || []; if (!fichiers.length || !window.CMKT_DOUBLONS) return;
    const hashes = await Promise.all(fichiers.map(f => f ? empreinteFichier(f) : null));
    for (let i = 0; i < fichiers.length; i++) {
        const champ = document.getElementById('ia-lot-name-' + i); if (!champ) continue;
        const sur = await doublonsPhoto(fichiers[i], null);
        let texte = '';
        if (sur.length) texte = (sur[0].distance <= window.CMKT_DOUBLONS.SEUIL_PHOTO_IDENTIQUE ? '📷 Photo déjà utilisée par « ' : '📷 Photo ressemblante à celle de « ') + sur[0].produit.name + ' »';
        else for (let j = 0; j < i; j++) { if (hashes[i] && hashes[j] && window.CMKT_DOUBLONS.distanceEmpreintes(hashes[i], hashes[j]) <= window.CMKT_DOUBLONS.SEUIL_PHOTO_IDENTIQUE) { texte = `📷 Photo quasi identique à celle de la fiche n°${j + 1} de ce lot`; break; } }
        let note = champ.parentElement.querySelector('.doublon-note-photo');
        if (!note) { note = document.createElement('div'); note.className = 'doublon-note doublon-note-photo'; champ.parentElement.append(note); }
        note.textContent = texte; note.style.display = texte ? 'block' : 'none';
    }
}

// Scan de tout le catalogue : noms, photos (même fichier ou visuellement identiques), descriptions, prix.
function ouvrirScanDoublons() {
    if (document.getElementById('scan-doublons') || !window.CMKT_DOUBLONS) return;
    const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    const lireIgnores = () => { try { return new Set(JSON.parse(localStorage.getItem(CLE_IGNORES) || '[]')); } catch (e) { return new Set(); } };
    const signature = ids => ids.map(String).sort().join('|');
    const ancienScroll = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const ov = el('div', 'photo-overlay'); ov.id = 'scan-doublons'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    const feuille = el('div', 'photo-sheet doublon-large'), tete = el('div', 'photo-head');
    const btnX = el('button', 'photo-x', '✕'); btnX.type = 'button'; btnX.setAttribute('aria-label', 'Fermer');
    tete.append(el('h3', null, '🔎 Scan des doublons'), btnX);
    const corps = el('div', 'photo-body'); feuille.append(tete, corps); ov.append(feuille); document.body.append(ov);
    let ferme = false;
    const fermer = () => { ferme = true; document.removeEventListener('keydown', surTouche); document.body.style.overflow = ancienScroll; ov.remove(); };
    function surTouche(e) { if (e.key === 'Escape') fermer(); }
    document.addEventListener('keydown', surTouche); btnX.onclick = fermer;

    async function supprimer(p) {
        if (!confirm(`Supprimer définitivement « ${p.name} » ?`)) return;
        try { await adminAction('products', 'delete', { id: p.id }); window._prods = (window._prods || []).filter(x => x.id !== p.id); rendre(); if (typeof rafraichirProduits === 'function') rafraichirProduits(); }
        catch (e) { alert('Suppression impossible : ' + e.message); }
    }
    function rendre() {
        if (ferme) return;
        const prods = window._prods || [];
        const parId = new Map(prods.map(p => [p.id, p]));
        const ignores = lireIgnores();
        const groupes = window.CMKT_DOUBLONS.scannerCatalogue(prods, window._empreintes).filter(g => !ignores.has(signature(g.ids)));
        const avecPhoto = prods.filter(p => p.image_url);
        const lues = avecPhoto.filter(p => window._empreintes[String(p.image_url).trim()]).length;
        corps.replaceChildren(el('p', 'photo-note', `${prods.length} produits analysés · ${lues} photos comparées${avecPhoto.length > lues ? ` · ${avecPhoto.length - lues} photo(s) illisible(s) (comparées par adresse seulement)` : ''}`));
        if (!groupes.length) { corps.append(el('div', 'photo-ico', '✅'), el('p', 'photo-etat', 'Aucun doublon trouvé dans ton catalogue.')); }
        groupes.forEach((g, n) => {
            const carte = el('div', 'scan-carte');
            carte.append(el('div', 'doublon-titre', `Groupe ${n + 1} · ${g.confiance} · ${g.raisons.join(' · ')}`));
            g.ids.map(id => parId.get(id)).filter(Boolean).sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || ''))).forEach(p => {
                const ligne = el('div', 'scan-ligne');
                const vignette = p.image_url ? Object.assign(el('img', 'scan-vignette'), { src: p.image_url, alt: '', loading: 'lazy' }) : el('span', 'scan-vignette scan-vide', '📦');
                const infos = el('div', 'scan-infos'); infos.append(el('b', null, p.name), el('span', null, `${p.category || '—'} · ${p.resale_price != null ? fmt(p.resale_price) + ' FCFA' : '—'} · ${p.quantity === 0 ? 'rupture' : 'stock ' + (p.quantity != null ? p.quantity : '—')}${p.created_at ? ' · ajouté le ' + String(p.created_at).slice(0, 10) : ''}`));
                const ouvrir = el('button', 'doublon-btn', '✏️ Ouvrir'); ouvrir.type = 'button'; ouvrir.onclick = () => { fermer(); chargerEditProduit(p.id); };
                const sup = el('button', 'doublon-btn scan-danger', '🗑️ Supprimer'); sup.type = 'button'; sup.onclick = () => supprimer(p);
                ligne.append(vignette, infos, ouvrir, sup); carte.append(ligne);
            });
            const diff = el('button', 'doublon-btn', 'Ce sont des produits différents (ne plus signaler)'); diff.type = 'button';
            diff.onclick = () => { const s = lireIgnores(); s.add(signature(g.ids)); try { localStorage.setItem(CLE_IGNORES, JSON.stringify([...s])); } catch (e) {} rendre(); };
            carte.append(diff); corps.append(carte);
        });
        const relancer = el('button', 'photo-btn', '🔄 Relancer le scan'); relancer.type = 'button'; relancer.onclick = demarrer; corps.append(relancer);
    }
    async function demarrer() {
        const barre = el('div', 'scan-barre'), rempli = el('div', 'scan-barre-rempli'); barre.append(rempli);
        const texte = el('p', 'photo-etat', 'Comparaison des photos du catalogue…');
        corps.replaceChildren(el('div', 'photo-spinner'), texte, barre);
        window._empreintesEchecs.clear();
        await empreintesCatalogue((fait, total) => { if (ferme) return; rempli.style.width = Math.round(100 * fait / Math.max(1, total)) + '%'; texte.textContent = `Comparaison des photos du catalogue… ${fait}/${total}`; });
        rendre();
    }
    demarrer();
}
window.ouvrirScanDoublons = ouvrirScanDoublons;

// Appelle l'analyse IA. Si l'IA est très sollicitée ou si la limite est atteinte, réessaie seule (3 fois, avec compte à rebours).
async function appelAnalyseIA(images, modeLot, res) {
    const attentes = [8, 15, 25];   // secondes avant chaque nouvelle tentative
    for (let essai = 0; ; essai++) {
        let resp = null, data;
        try {
            resp = await fetch('/api/analyser-produit', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (sessionStorage.getItem('cmkt_admin_token') || '') },
                body: JSON.stringify({ images, mode: modeLot ? 'lot' : 'unique' })
            });
            data = await resp.json();
        } catch (e) { resp = null; data = { error: 'Connexion interrompue.', code: 'reseau' }; }
        if (resp && resp.ok && !data.error) return data;
        const passager = !resp || ['surcharge', 'quota', 'reseau'].includes(data.code);
        if (!passager) throw new Error(data.error || 'Erreur IA');
        if (essai >= attentes.length) throw new Error((data.error || "L'IA est indisponible.") + " Tu peux remplir la fiche à la main : « Enregistrer » fonctionne sans l'IA.");
        for (let sec = attentes[essai]; sec > 0; sec--) {
            res.style.color = '#c77c00';
            res.textContent = `⏳ L'IA est très sollicitée — nouvelle tentative dans ${sec} s (${essai + 1}/${attentes.length})…`;
            await new Promise(ok => setTimeout(ok, 1000));
        }
        res.style.color = '#888'; res.textContent = 'Nouvelle tentative…';
    }
}

window.analyserProduitIA = async () => {
    const res = document.getElementById('ia-res');
    const modeLot = document.getElementById('ia-mode-lot').checked;
    const fichiers = selectedFilesAll.length ? selectedFilesAll : (selectedFile ? [selectedFile] : []);
    if (!fichiers.length) { res.style.color = '#D9534F'; res.textContent = '❌ Uploade d\'abord au moins une photo.'; return; }
    if (modeLot && fichiers.length < 2) { res.style.color = '#D9534F'; res.textContent = '❌ Le mode "produits différents" demande au moins 2 photos.'; return; }
    const btn = document.getElementById('btn-ia-analyser');
    btn.disabled = true; btn.textContent = '⏳ Analyse...';
    res.style.color = '#888'; res.textContent = modeLot ? `L'IA regarde les ${fichiers.length} photos séparément...` : (fichiers.length > 1 ? `L'IA regarde les ${fichiers.length} photos...` : 'L\'IA regarde la photo...');
    try {
        // Photos réduites (1024 px) : envoi rapide et requêtes légères (une photo de téléphone pèse 3 à 8 Mo).
        const images = await Promise.all(fichiers.map(async f => { const p = await preparerImagePhoto(f, 1024, 0.8); return { data: p.base64, media_type: 'image/jpeg' }; }));
        // Mode « produits différents » : lots de 4 photos, un après l'autre. Chaque lot est réessayé seul si l'IA est surchargée.
        const taille = modeLot ? 4 : 8, groupes = [];
        for (let k = 0; k < images.length; k += taille) groupes.push(images.slice(k, k + taille));
        let data = modeLot ? [] : null;
        for (let g = 0; g < groupes.length; g++) {
            if (groupes.length > 1) { res.style.color = '#888'; res.textContent = `L'IA regarde les photos… lot ${g + 1}/${groupes.length}`; }
            const part = await appelAnalyseIA(groupes[g], modeLot, res);
            if (modeLot) data = data.concat(Array.isArray(part) ? part : (part.produits || [])); else data = part;
        }
        if (modeLot) {
            const liste = Array.isArray(data) ? data : (data.produits || []);
            afficherResultatsLot(liste, fichiers); marquerDoublonsLot(); marquerDoublonsPhotosLot();
            res.style.color = '#3FA66B'; res.textContent = `✅ ${liste.length} produit(s) détecté(s) — complète le prix et la quantité de chacun ci-dessous.`;
        } else {
            if (data.name) { document.getElementById('p-name').value = data.name; majAlerteDoublon(); }
            if (data.description) document.getElementById('p-desc').value = data.description;
            if (data.category) document.getElementById('p-cat').value = data.category;
            res.style.color = '#3FA66B'; res.textContent = '✅ Nom, catégorie et description pré-remplis — vérifie et ajoute le prix + la quantité.';
        }
    } catch (e) {
        res.style.color = '#D9534F';
        res.textContent = '❌ ' + (e.message === 'format' ? 'Une des photos est illisible (format non pris en charge) : essaie une photo JPG ou PNG.'
            : e.message === 'trop-grande' ? 'Une des photos est trop lourde (25 Mo maximum).' : e.message);
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
                <button onclick="validerProduitLot(${i})" id="ia-lot-btn-${i}" style="align-self:flex-start;background:#1F6B3A;color:white;border:none;padding:8px 16px;border-radius:7px;font-size:0.82rem;cursor:pointer;font-weight:600">✅ Ajouter ce produit</button>
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
    if (!name) { res.style.color = '#D9534F'; res.textContent = '❌ Nom requis'; return; }
    if (!achat || achat <= 0) { res.style.color = '#D9534F'; res.textContent = '❌ Prix d\'achat requis'; return; }
    if (!vente || vente <= 0) { res.style.color = '#D9534F'; res.textContent = '❌ Prix de vente requis'; return; }
    if (!qte || qte < 0) { res.style.color = '#D9534F'; res.textContent = '❌ Quantité requise'; return; }
    let forcer = false;
    res.style.color = '#888'; res.textContent = '🔎 Vérification des doublons…';
    const parNom = doublonsPour(name, null);
    const parPhoto = (await doublonsPhoto((window._iaLotFichiers || [])[i], null)).filter(x => !parNom.some(y => y.produit.id === x.produit.id));
    const dejaLa = [...parNom, ...parPhoto];
    res.textContent = '';
    if (dejaLa.length) {
        if (!(await confirmerDoublon(name, null, dejaLa))) { res.style.color = '#c77c00'; res.textContent = 'Ajout annulé : cet article existe déjà.'; return; }
        forcer = true;
    }
    btn.disabled = true; btn.textContent = '⏳ Ajout...';
    try {
        const fichier = window._iaLotFichiers[i];
        const imageUrl = fichier ? await uploadImage(fichier) : null;
        const reponse = await insererProduitAvecControle({
            name, description: desc, category: cat,
            purchase_price: achat, resale_price: vente, quantity: qte, image_url: imageUrl
        }, forcer);
        if (reponse && reponse.data) window._prods = [reponse.data, ...(window._prods || [])];   // visible tout de suite pour les fiches suivantes du lot
        res.style.color = '#3FA66B'; res.textContent = '✅ Produit ajouté !';
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
                if (msg) { msg.style.color = '#3FA66B'; msg.textContent = '✅ Tous les produits du lot ont été ajoutés !'; }
            }
        }, 900);
    } catch (e) {
        res.style.color = e.annule ? '#c77c00' : '#D9534F'; res.textContent = (e.annule ? '' : '❌ ') + e.message;
        btn.disabled = false; btn.textContent = '✅ Ajouter ce produit';
    }
};

window.sauvegarderProduit = async () => {
    const msg=document.getElementById('prod-msg');
    const name=document.getElementById('p-name').value.trim();
    const qty=parseInt(document.getElementById('p-qty').value);
    const achat=parseFloat(document.getElementById('p-achat').value);
    const vente=parseFloat(document.getElementById('p-vente').value);
    if(!name||!qty||!achat||!vente){msg.style.color='#D9534F';msg.textContent='❌ Remplissez les champs obligatoires';return;}
    // Anti-doublon : si un produit identique ou très ressemblant existe déjà, on demande confirmation avant d'ajouter.
    let forcer = false;
    msg.style.color = '#888'; msg.textContent = '🔎 Vérification des doublons…';
    const parNom = doublonsPour(name, editingId);
    const parPhoto = (await Promise.all(selectedFilesAll.map(f => doublonsPhoto(f, editingId)))).flat()
        .filter((x, k, t) => t.findIndex(y => y.produit.id === x.produit.id) === k && !parNom.some(y => y.produit.id === x.produit.id));
    const dejaLa = [...parNom, ...parPhoto];
    if (dejaLa.length) {
        if (!(await confirmerDoublon(name, editingId, dejaLa))) { msg.style.color = '#c77c00'; msg.textContent = editingId ? 'Modification annulée : ce nom existe déjà.' : 'Ajout annulé : cet article existe déjà.'; return; }
        forcer = true;
    }
    msg.style.color='#888';msg.textContent='Enregistrement...';
    let imageUrl=document.getElementById('p-img-url').value.trim();
    if(selectedFile){try{imageUrl=await uploadImage(selectedFile);}catch(e){msg.style.color='#D9534F';msg.textContent='❌ Upload: '+e.message;return;}}
    const prod={name,description:document.getElementById('p-desc').value.trim()||null,category:document.getElementById('p-cat').value,quantity:qty,purchase_price:achat,resale_price:vente,image_url:imageUrl||null,promo_active:document.getElementById('p-promo-chk').checked,promo_prix:parseFloat(document.getElementById('p-promo').value)||null,flash_active:document.getElementById('p-flash-chk').checked,flash_fin:document.getElementById('p-flash-fin').value?new Date(document.getElementById('p-flash-fin').value).toISOString():null};
    try {
        const reponse = await (editingId ? adminAction('products','update',{id:editingId,payload:prod}) : insererProduitAvecControle(prod, forcer));
        if (!editingId && reponse && reponse.data) window._prods = [reponse.data, ...(window._prods || [])];   // visible tout de suite pour le contrôle des doublons suivants
    } catch(e) { msg.style.color = e.annule ? '#c77c00' : '#D9534F'; msg.textContent = (e.annule ? '' : '❌ ') + e.message; return; }
    msg.style.color='#3FA66B';msg.textContent='✅ Enregistré !';
    annulerEdit();
    rafraichirProduits();
};

window.chargerEditProduit = id => {
    const p=window._prods.find(x=>x.id===id); if(!p)return;
    editingId=id;
    document.getElementById('prod-form-title').textContent='✏️ Modifier le produit';
    document.getElementById('p-name').value=p.name; majAlerteDoublon();
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
    const t=document.getElementById('prod-form-title');if(t)t.textContent='➕ Ajouter un Produit'; majAlerteDoublon(); majAlertePhoto();
    const b=document.getElementById('btn-annuler-edit');if(b)b.style.display='none';
};

window.supprimerProduit = async id => { if(!confirm('Supprimer ce produit ?'))return; await adminAction('products','delete',{id}); rafraichirProduits(); };
window.toggleFlash = async (id, actif) => { await adminAction('products','update',{id,payload:{flash_active:!actif}}); rafraichirProduits(); };

let editingBanniereId = null;
window.publierMessage = async () => {
    const msg=document.getElementById('mktg-msg').value.trim();
    const type=document.getElementById('mktg-type').value;
    const res=document.getElementById('mktg-res');
    if(!msg){res.style.color='#D9534F';res.textContent='❌ Message vide';return;}
    const payload={message:msg,type,actif:true};
    if(type==='slider'){
        let sliderUrl = document.getElementById('mktg-img-url').value.trim();
        if (sliderImgFile) {
            res.style.color='#888'; res.textContent='⏳ Envoi de l\'image...';
            try { sliderUrl = await uploadImage(sliderImgFile); }
            catch(e){ res.style.color='#D9534F'; res.textContent='❌ Upload: '+e.message; return; }
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
            catch(e){ res.style.color='#D9534F'; res.textContent='❌ Upload: '+e.message; return; }
        }
        payload.image_url = flyerUrl || null;
        payload.lien = document.getElementById('mktg-popup-lien').value.trim() || null;
        const idsChoisis = Array.from(document.querySelectorAll('.mktg-prod-chk:checked')).map(c=>c.value).slice(0,4);
        payload.produits_ids = idsChoisis.length ? idsChoisis : null;
    }
    try {
        if (editingBanniereId) await adminAction('bannieres','update',{id:editingBanniereId,payload});
        else await adminAction('bannieres','insert',{payload});
    }
    catch(e){res.style.color='#D9534F';res.textContent='❌ '+e.message;return;}
    res.style.color='#3FA66B';res.textContent='✅ Publié !';
    annulerEditBanniere();
    popupFlyerFile = null;
    sliderImgFile = null;
    setTimeout(()=>afficherPanneauAdmin(),600);
};

// Pré-remplit le formulaire du haut avec la bannière/popup/slide existant —
// évite de devoir la supprimer et tout retaper pour changer un simple mot.
window.chargerEditBanniere = (id) => {
    const b = (window._bannieres || []).find(x => x.id === id); if (!b) return;
    editingBanniereId = id;
    document.getElementById('mktg-form-title').textContent = '✏️ Modifier le message';
    document.getElementById('mktg-msg').value = b.message || '';
    document.getElementById('mktg-type').value = b.type;
    document.getElementById('mktg-type').onchange();
    if (b.type === 'slider') {
        document.getElementById('mktg-titre').value = b.titre || '';
        document.getElementById('mktg-tag').value = b.tag || '';
        document.getElementById('mktg-img-url').value = b.image_url || '';
        document.getElementById('mktg-btn-txt').value = b.btn_texte || '';
        document.getElementById('mktg-slide-produit').value = b.produit_id || '';
        document.getElementById('mktg-prix-actuel').value = b.prix_actuel || '';
        document.getElementById('mktg-prix-ancien').value = b.prix_ancien || '';
        if (b.image_url) { document.getElementById('mktg-slider-preview-img').src = b.image_url; document.getElementById('mktg-slider-preview').style.display = 'block'; }
    }
    if (b.type === 'popup') {
        document.getElementById('mktg-popup-img').value = b.image_url || '';
        document.getElementById('mktg-popup-lien').value = b.lien || '';
        if (b.image_url) { document.getElementById('mktg-popup-preview-img').src = b.image_url; document.getElementById('mktg-popup-preview').style.display = 'block'; }
        const idsChoisis = new Set(b.produits_ids || []);
        document.querySelectorAll('.mktg-prod-chk').forEach(cb => { cb.checked = idsChoisis.has(cb.value); });
    }
    document.getElementById('btn-publier-mktg').textContent = '💾 Enregistrer les modifications';
    document.getElementById('btn-annuler-edit-mktg').style.display = '';
    showTab('tab-mktg'); window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.annulerEditBanniere = () => {
    editingBanniereId = null;
    document.getElementById('mktg-msg').value = '';
    ['mktg-titre','mktg-tag','mktg-img-url','mktg-btn-txt','mktg-prix-actuel','mktg-prix-ancien','mktg-popup-img','mktg-popup-lien'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    const sp = document.getElementById('mktg-slide-produit'); if (sp) sp.value = '';
    document.querySelectorAll('.mktg-prod-chk').forEach(cb => { cb.checked = false; });
    const sPrev = document.getElementById('mktg-slider-preview'); if (sPrev) sPrev.style.display = 'none';
    const pPrev = document.getElementById('mktg-popup-preview'); if (pPrev) pPrev.style.display = 'none';
    document.getElementById('mktg-form-title').textContent = '📢 Publier un message';
    document.getElementById('btn-publier-mktg').textContent = 'Publier';
    document.getElementById('btn-annuler-edit-mktg').style.display = 'none';
};

window.toggleBanniere = async (id, actif) => { await adminAction('bannieres','update',{id,payload:{actif}}); afficherPanneauAdmin(); };
window.supprimerBanniere = async (id) => { if(!confirm('Supprimer définitivement ce message ?'))return; await adminAction('bannieres','delete',{id}); afficherPanneauAdmin(); };

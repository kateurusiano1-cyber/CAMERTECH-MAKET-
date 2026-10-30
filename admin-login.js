// admin-login.js — SEULE partie publique de l'espace admin : écran de connexion.
// Le panneau lui-même (produits, commandes, clients, paramètres…) n'est PAS dans ce fichier :
// il est téléchargé après connexion, depuis /api/admin-auth?bundle=1, avec le jeton signé.
// Sans connexion valide, le serveur refuse (401) et personne ne peut lire le code du panneau.
const db = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
let evenementInstallPwa = null;

function setupPwaAdmin() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
        let dejaRecharge = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (dejaRecharge) return;
            dejaRecharge = true;
            window.location.reload();
        });
    }
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); evenementInstallPwa = e; });
}

// Télécharge puis exécute le panneau admin (uniquement si le jeton de session est valide).
async function chargerPanneauAdmin() {
    const token = sessionStorage.getItem('cmkt_admin_token') || '';
    const resp = await fetch('/api/admin-auth?bundle=1', { headers: { 'Authorization': 'Bearer ' + token }, cache: 'no-store' });
    if (!resp.ok) {
        const e = new Error(resp.status === 401 ? 'Session expirée' : 'Chargement impossible');
        e.status = resp.status; throw e;
    }
    const code = await resp.text();
    const s = document.createElement('script');
    s.textContent = code;
    document.head.appendChild(s);
    afficherPanneauAdmin();
}

// ===== LOGIN ADMIN =====
function afficherLoginAdmin() {
    document.body.innerHTML=`
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f6f4;padding:20px;font-family:Inter,sans-serif">
        <div style="background:white;border-radius:18px;padding:36px;max-width:380px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.1)">
            <img src="/logo-panier.png" alt="Logo Kapmaket" style="height:70px;width:70px;border-radius:50%;margin-bottom:14px;border:3px solid #1a5c2a">
            <h1 style="color:#1a5c2a;font-family:Poppins,sans-serif;margin-bottom:4px;font-size:1.3rem">Kapmaket</h1>
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
        const msg=encodeURIComponent(`🔐 Kapmaket\nCode admin : ${data.code}\nValide 5 min.`);
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
        sessionStorage.setItem('cmkt_admin_token', data.token);
        sessionStorage.setItem('cmkt_admin_id', data.id);
        sessionStorage.setItem('cmkt_admin_wa', data.wa);
        await chargerPanneauAdmin();
    } catch (e) {
        err.textContent = '❌ Erreur réseau, réessaie';
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Confirmer'; }
    }
};


document.addEventListener('DOMContentLoaded', async () => {
    setupPwaAdmin();
    // Session encore valide (même onglet) : on rouvre directement le panneau.
    if (sessionStorage.getItem('cmkt_admin_token')) {
        try { await chargerPanneauAdmin(); return; }
        catch (e) { ['cmkt_admin_token', 'cmkt_admin_id', 'cmkt_admin_wa'].forEach(k => sessionStorage.removeItem(k)); }
    }
    afficherLoginAdmin();
});

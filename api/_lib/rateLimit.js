// api/_lib/rateLimit.js
// Limite le nombre de tentatives pour une clé donnée (ex: mot de passe admin,
// code OTP). Réutilise la table `login_attempts`, déjà créée dans le projet
// et déjà réservée à un usage 100% serveur (aucune policy anon dessus).

const CONFIG = require('../../config.js');

// Les limites des clients se coupent d'un seul endroit (CONFIG.LIMITES_CLIENTS_ACTIVES dans config.js).
// Les clés de connexion administrateur (admin-login:…, admin-otp:…) restent toujours protégées.
const limiteActive = (cle) => CONFIG.LIMITES_CLIENTS_ACTIVES === true || /^admin-/.test(String(cle));

async function tropDeTentatives(supabase, cle, maxTentatives = 5, blocageMinutes = 15) {
    if (!limiteActive(cle)) return { bloque: false };   // limites coupées : même un ancien blocage enregistré est ignoré
    const { data } = await supabase.from('login_attempts').select('*').eq('cle', cle).single();
    if (data?.bloque_jusqu && new Date(data.bloque_jusqu) > new Date()) {
        return { bloque: true, retryAfterSeconds: Math.ceil((new Date(data.bloque_jusqu) - new Date()) / 1000) };
    }
    return { bloque: false };
}

// Compte une tentative. `updated_at` sert de début de fenêtre : le compteur repart de zéro quand la fenêtre
// (durée = blocageMinutes) est écoulée ou quand un blocage est levé. Avant, il ne repartait jamais de zéro :
// après 20 actions au total, un client était bloqué à chaque nouvelle action, indéfiniment.
async function signalerEchecTentative(supabase, cle, maxTentatives = 5, blocageMinutes = 15) {
    if (!limiteActive(cle)) return;   // limites coupées : on ne compte rien
    const { data } = await supabase.from('login_attempts').select('*').eq('cle', cle).single();
    const maintenant = Date.now();
    const bloqueEncore = !!(data && data.bloque_jusqu && new Date(data.bloque_jusqu).getTime() > maintenant);
    const debut = data && data.updated_at ? new Date(data.updated_at).getTime() : 0;
    const nouvelleFenetre = !data || (data.bloque_jusqu && !bloqueEncore) || (maintenant - debut) > blocageMinutes * 60000;
    const tentatives = nouvelleFenetre ? 1 : (data.tentatives || 0) + 1;
    const bloque_jusqu = tentatives >= maxTentatives ? new Date(maintenant + blocageMinutes * 60000).toISOString() : null;
    const ligne = { cle, tentatives, bloque_jusqu };
    if (nouvelleFenetre) ligne.updated_at = new Date(maintenant).toISOString();   // sinon on garde le début de la fenêtre
    await supabase.from('login_attempts').upsert(ligne);
}

async function reinitialiserTentatives(supabase, cle) {
    await supabase.from('login_attempts').delete().eq('cle', cle);
}

module.exports = { tropDeTentatives, signalerEchecTentative, reinitialiserTentatives };

// api/_lib/rateLimit.js
// Limite le nombre de tentatives pour une clé donnée (ex: mot de passe admin,
// code OTP). Réutilise la table `login_attempts`, déjà créée dans le projet
// et déjà réservée à un usage 100% serveur (aucune policy anon dessus).

async function tropDeTentatives(supabase, cle, maxTentatives = 5, blocageMinutes = 15) {
    const { data } = await supabase.from('login_attempts').select('*').eq('cle', cle).single();
    if (data?.bloque_jusqu && new Date(data.bloque_jusqu) > new Date()) {
        return { bloque: true, retryAfterSeconds: Math.ceil((new Date(data.bloque_jusqu) - new Date()) / 1000) };
    }
    return { bloque: false };
}

async function signalerEchecTentative(supabase, cle, maxTentatives = 5, blocageMinutes = 15) {
    const { data } = await supabase.from('login_attempts').select('*').eq('cle', cle).single();
    const tentatives = (data?.tentatives || 0) + 1;
    const bloque_jusqu = tentatives >= maxTentatives ? new Date(Date.now() + blocageMinutes * 60000).toISOString() : null;
    await supabase.from('login_attempts').upsert({ cle, tentatives, bloque_jusqu, updated_at: new Date().toISOString() });
}

async function reinitialiserTentatives(supabase, cle) {
    await supabase.from('login_attempts').delete().eq('cle', cle);
}

module.exports = { tropDeTentatives, signalerEchecTentative, reinitialiserTentatives };

// api/push-subscribe.js
// Enregistre l'abonnement push du navigateur d'un client OU d'un membre de
// l'équipe (admin) — l'écriture se fait toujours avec la clé service (la
// table n'a aucune policy anon).

const { createClient } = require('@supabase/supabase-js');
const { verifierRequeteUtilisateur } = require('./_lib/verifierFirebaseToken');
const { verifierRequeteAdmin } = require('./_lib/adminSession');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    let utilisateurId = null;
    let estAdmin = false;

    const sessionAdmin = verifierRequeteAdmin(req, process.env.ADMIN_SESSION_SECRET);
    if (sessionAdmin) {
        estAdmin = true;
    } else {
        const uid = await verifierRequeteUtilisateur(req);
        if (!uid) return res.status(401).json({ error: 'Session invalide, reconnecte-toi' });
        const { data: user } = await supabase.from('utilisateurs').select('id').eq('firebase_uid', uid).single();
        if (!user) return res.status(404).json({ error: 'Profil introuvable' });
        utilisateurId = user.id;
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { endpoint, keys } = body?.subscription || body || {};
        if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'Abonnement invalide' });

        await supabase.from('push_subscriptions').upsert([{
            utilisateur_id: utilisateurId, is_admin: estAdmin, endpoint, p256dh: keys.p256dh, auth: keys.auth
        }], { onConflict: 'endpoint' });

        return res.status(200).json({ ok: true });
    } catch (e) {
        console.error('Erreur push-subscribe:', e.message);
        return res.status(500).json({ error: 'Erreur serveur' });
    }
};

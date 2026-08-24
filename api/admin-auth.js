// api/admin-auth.js
// Fusionne les deux étapes de la connexion admin (identifiant+mot de passe,
// puis code OTP WhatsApp) dans UN SEUL fichier — le forfait Vercel Hobby
// limite à 12 fonctions serverless par déploiement, donc chaque fichier
// séparé dans api/ compte. Le comportement est strictement identique à
// avant (deux appels distincts, avec { step: 1 } puis { step: 2 }),
// seul le regroupement de fichier a changé.
//
// Variables d'environnement Vercel nécessaires :
//   ADMINS_JSON  = tableau JSON des admins, ex :
//     [{"id":"EVAR_ADMIN_1","mdp":"...","wa":"237699781160"}, ...]
//   ADMIN_SESSION_SECRET  (longue chaîne aléatoire — sert à signer les sessions)

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { tropDeTentatives, signalerEchecTentative, reinitialiserTentatives } = require('./_lib/rateLimit');
const { creerToken } = require('./_lib/adminSession');

function comparerEnTempsConstant(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

function listeAdmins() {
    if (!process.env.ADMINS_JSON) return [];
    try {
        const admins = JSON.parse(process.env.ADMINS_JSON);
        return Array.isArray(admins) ? admins.filter(a => a && a.id && a.mdp && a.wa) : [];
    } catch (e) {
        console.error('ADMINS_JSON invalide (doit être un tableau JSON) :', e.message);
        return [];
    }
}

async function etape1(req, res, supabase) {
    const { id, mdp } = req.body || {};
    if (!id || !mdp) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
    if (!process.env.ADMIN_SESSION_SECRET) return res.status(500).json({ error: 'Configuration serveur incomplète (ADMIN_SESSION_SECRET manquant sur Vercel)' });

    const cle = `admin-login:${id}`;
    const check = await tropDeTentatives(supabase, cle);
    if (check.bloque) return res.status(429).json({ error: `Trop de tentatives. Réessaie dans ${Math.ceil(check.retryAfterSeconds / 60)} min.` });

    const admins = listeAdmins();
    if (!admins.length) return res.status(500).json({ error: "Aucun admin configuré côté serveur (ADMINS_JSON manquant)" });

    const admin = admins.find(a => comparerEnTempsConstant(a.id, id));
    const motDePasseValide = admin ? comparerEnTempsConstant(admin.mdp, mdp) : false;
    if (!admin || !motDePasseValide) {
        await signalerEchecTentative(supabase, cle);
        return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
    }
    await reinitialiserTentatives(supabase, cle);

    const code = String(crypto.randomInt(1000, 10000));
    const codeHash = crypto.createHash('sha256').update(code).digest('hex');
    const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();

    const { data: otp, error } = await supabase.from('admin_otp').insert([{
        admin_id: admin.id, code_hash: codeHash, wa: admin.wa, expires_at: expiresAt
    }]).select().single();
    if (error) throw error;

    return res.status(200).json({ ticket: otp.ticket, wa: admin.wa, code });
}

async function etape2(req, res, supabase) {
    const { ticket, code } = req.body || {};
    if (!ticket || !code) return res.status(400).json({ error: 'Ticket et code requis' });
    if (!process.env.ADMIN_SESSION_SECRET) return res.status(500).json({ error: 'Configuration serveur incomplète (ADMIN_SESSION_SECRET manquant sur Vercel)' });

    const cle = `admin-otp:${ticket}`;
    const check = await tropDeTentatives(supabase, cle, 5, 15);
    if (check.bloque) return res.status(429).json({ error: 'Trop de tentatives. Recommence la connexion depuis le début.' });

    const { data: otp } = await supabase.from('admin_otp').select('*').eq('ticket', ticket).single();
    const codeHash = crypto.createHash('sha256').update(String(code)).digest('hex');
    const hashValide = otp && crypto.timingSafeEqual(Buffer.from(otp.code_hash, 'hex'), Buffer.from(codeHash, 'hex'));
    const valide = otp && !otp.used && new Date(otp.expires_at) > new Date() && hashValide;

    if (!valide) {
        await signalerEchecTentative(supabase, cle, 5, 15);
        return res.status(401).json({ error: 'Code incorrect ou expiré' });
    }

    await supabase.from('admin_otp').update({ used: true }).eq('ticket', ticket);
    await reinitialiserTentatives(supabase, cle);

    const token = creerToken({ id: otp.admin_id, wa: otp.wa }, process.env.ADMIN_SESSION_SECRET, 12 * 3600);
    return res.status(200).json({ token, id: otp.admin_id, wa: otp.wa });
}

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        req.body = body;
        if (body.step === 2) return await etape2(req, res, supabase);
        return await etape1(req, res, supabase);
    } catch (e) {
        console.error('Erreur admin-auth:', e);
        return res.status(500).json({ error: 'Erreur serveur' });
    }
};

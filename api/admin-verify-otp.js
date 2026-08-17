// api/admin-verify-otp.js
// Étape 2 de la connexion admin : vérifie le code à 4 chiffres CÔTÉ SERVEUR
// (contre le hash stocké en base par admin-login.js), avec limitation de
// tentatives. Si valide, délivre un vrai jeton de session signé.
//
// Avant : `code !== adminCodeTemp` était comparé dans le navigateur, et
// `isAdmin=true` pouvait être forcé directement depuis la console devtools
// sans même connaître le code. Ce n'était pas une vraie protection.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { tropDeTentatives, signalerEchecTentative, reinitialiserTentatives } = require('./_lib/rateLimit');
const { creerToken } = require('./_lib/adminSession');

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const { ticket, code } = body;
        if (!ticket || !code) return res.status(400).json({ error: 'Ticket et code requis' });

        if (!process.env.ADMIN_SESSION_SECRET) {
            return res.status(500).json({ error: 'Configuration serveur incomplète (ADMIN_SESSION_SECRET manquant sur Vercel)' });
        }

        const cle = `admin-otp:${ticket}`;
        const check = await tropDeTentatives(supabase, cle, 5, 15);
        if (check.bloque) {
            return res.status(429).json({ error: 'Trop de tentatives. Recommence la connexion depuis le début.' });
        }

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
    } catch (e) {
        console.error('Erreur admin-verify-otp:', e);
        return res.status(500).json({ error: 'Erreur serveur' });
    }
};

// api/admin-login.js
// Étape 1 de la connexion admin : vérifie identifiant + mot de passe
// UNIQUEMENT côté serveur, contre des variables d'environnement Vercel
// (jamais envoyées au navigateur). Remplace l'ancienne vérification
// `CONFIG.ADMINS.find(...)` qui exposait les 3 mots de passe admin en clair
// dans le code source visible par n'importe quel visiteur.
//
// Variables d'environnement Vercel à créer (Project Settings → Environment Variables) :
//   ADMINS_JSON  = tableau JSON des admins, ex :
//     [{"id":"EVAR_ADMIN_1","mdp":"...","wa":"237699781160"},
//      {"id":"EVAR_ADMIN_2","mdp":"...","wa":"237653756167"},
//      {"id":"EVAR_ADMIN_3","mdp":"...","wa":"237670554637"}]
//   ADMIN_SESSION_SECRET  (longue chaîne aléatoire — sert à signer les sessions)

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { tropDeTentatives, signalerEchecTentative, reinitialiserTentatives } = require('./_lib/rateLimit');

function comparerEnTempsConstant(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) {
        // Compare quand même contre elle-même pour garder un temps constant, puis refuse.
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

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const { id, mdp } = body;
        if (!id || !mdp) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });

        if (!process.env.ADMIN_SESSION_SECRET) {
            return res.status(500).json({ error: 'Configuration serveur incomplète (ADMIN_SESSION_SECRET manquant sur Vercel)' });
        }

        const cle = `admin-login:${id}`;
        const check = await tropDeTentatives(supabase, cle);
        if (check.bloque) {
            return res.status(429).json({ error: `Trop de tentatives. Réessaie dans ${Math.ceil(check.retryAfterSeconds / 60)} min.` });
        }

        const admins = listeAdmins();
        if (!admins.length) {
            return res.status(500).json({ error: "Aucun admin configuré côté serveur (variables ADMIN1_ID / ADMIN1_MDP / ADMIN1_WA manquantes)" });
        }

        const admin = admins.find(a => comparerEnTempsConstant(a.id, id));
        const motDePasseValide = admin ? comparerEnTempsConstant(admin.mdp, mdp) : false;

        if (!admin || !motDePasseValide) {
            await signalerEchecTentative(supabase, cle);
            return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
        }

        await reinitialiserTentatives(supabase, cle);

        // Code à 4 chiffres généré et stocké CÔTÉ SERVEUR (jamais devinable/lisible
        // depuis la console du navigateur comme c'était le cas avant).
        const code = String(crypto.randomInt(1000, 10000));
        const codeHash = crypto.createHash('sha256').update(code).digest('hex');
        const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();

        const { data: otp, error } = await supabase.from('admin_otp').insert([{
            admin_id: admin.id, code_hash: codeHash, wa: admin.wa, expires_at: expiresAt
        }]).select().single();
        if (error) throw error;

        // Le code est renvoyé ici uniquement pour pré-remplir le message WhatsApp
        // côté navigateur (lien wa.me, qui ne peut pas être envoyé par le serveur
        // sans passerelle payante). Il n'accorde par lui-même aucun accès : seule
        // /api/admin-verify-otp peut délivrer une vraie session, et est limitée en tentatives.
        return res.status(200).json({ ticket: otp.ticket, wa: admin.wa, code });
    } catch (e) {
        console.error('Erreur admin-login:', e);
        return res.status(500).json({ error: 'Erreur serveur' });
    }
};

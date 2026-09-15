// api/facture.js
// GET  : génère et renvoie le PDF (facture si payé, reçu de suivi marqué
//        "NON PAYÉ" sinon) — accès propriétaire (jeton Firebase) OU admin
//        (jeton admin).
// POST : deux usages, distingués par le champ "type" du body :
//        - { type: 'masquer', code, masquer } : masque/réaffiche une commande
//          côté client (n'efface jamais rien côté admin).
//        - { type: 'retour', code, motif } : crée une demande de retour —
//          remplace l'ancien insert direct depuis le navigateur (table
//          `retours` désormais fermée à la clé anon).

const { createClient } = require('@supabase/supabase-js');
const { verifierRequeteUtilisateur } = require('./_lib/verifierFirebaseToken');
const { verifierRequeteAdmin } = require('./_lib/adminSession');
const { genererFacturePdf } = require('./_lib/genererFacture');
const { tropDeTentatives, signalerEchecTentative } = require('./_lib/rateLimit');

module.exports = async (req, res) => {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    if (req.method === 'POST') {
        const uid = await verifierRequeteUtilisateur(req);
        if (!uid) return res.status(401).json({ error: 'Session invalide, reconnecte-toi' });
        try {
            const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            const { code, masquer, type, motif } = body || {};
            const { data: user } = await supabase.from('utilisateurs').select('id').eq('firebase_uid', uid).single();
            if (!user) return res.status(404).json({ error: 'Profil introuvable' });
            const { data: resa } = await supabase.from('reservations').select('id, utilisateur_id').eq('code', code).single();
            if (!resa || resa.utilisateur_id !== user.id) return res.status(403).json({ error: 'Cette commande ne vous appartient pas' });

            if (type === 'retour') {
                if (!motif || !String(motif).trim()) return res.status(400).json({ error: 'Motif requis' });
                const { error: errInsert } = await supabase.from('retours').insert([{
                    reservation_id: resa.id, utilisateur_id: user.id, code_commande: code, motif: String(motif).trim().slice(0, 1000)
                }]);
                if (errInsert) throw errInsert;
                return res.status(200).json({ ok: true });
            }

            await supabase.from('reservations').update({ masquee_client: !!masquer }).eq('code', code);
            return res.status(200).json({ ok: true });
        } catch (e) {
            console.error('Erreur facture (POST):', e.message);
            return res.status(500).json({ error: 'Erreur serveur' });
        }
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'Méthode non autorisée' });

    const code = req.query?.code;
    if (!code) return res.status(400).json({ error: 'Code de commande manquant' });

    try {
        const sessionAdmin = verifierRequeteAdmin(req, process.env.ADMIN_SESSION_SECRET);
        let autorise = !!sessionAdmin;

        if (!autorise) {
            const uid = await verifierRequeteUtilisateur(req);
            if (uid) {
                const { data: user } = await supabase.from('utilisateurs').select('id').eq('firebase_uid', uid).single();
                if (!user) return res.status(404).json({ error: 'Profil introuvable' });
                const { data: resaCheck } = await supabase.from('reservations').select('utilisateur_id').eq('code', code).single();
                if (!resaCheck || resaCheck.utilisateur_id !== user.id) return res.status(403).json({ error: 'Cette commande ne vous appartient pas' });
                autorise = true;
            } else {
                // Achat invité (sans compte) : le code de commande fait office
                // de secret (généré via crypto.randomBytes, ~10^12 combinaisons,
                // cf. audit sécurité) — accès autorisé uniquement si la commande
                // est bien une commande invité (aucun compte associé), avec un
                // rate-limit par IP contre le bruteforce, comme pour le suivi public.
                const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'inconnu';
                const cleLimite = 'telecharger-facture-invite:' + ip;
                const { bloque, retryAfterSeconds } = await tropDeTentatives(supabase, cleLimite, 20, 15);
                if (bloque) return res.status(429).json({ error: `Trop de tentatives, réessaie dans ${Math.ceil(retryAfterSeconds/60)} min` });
                const { data: resaCheck } = await supabase.from('reservations').select('utilisateur_id').eq('code', code).single();
                if (!resaCheck) { await signalerEchecTentative(supabase, cleLimite, 20, 15); return res.status(404).json({ error: 'Commande introuvable' }); }
                if (resaCheck.utilisateur_id) return res.status(401).json({ error: 'Session invalide, reconnecte-toi' });
                autorise = true;
            }
        }

        const { data: resa } = await supabase.from('reservations').select('*').eq('code', code).single();
        if (!resa) return res.status(404).json({ error: 'Commande introuvable' });

        // On récupère les photos des articles depuis le catalogue (elles ne
        // sont pas stockées dans la commande elle-même) pour les afficher
        // sur le PDF — le client doit reconnaître visuellement ce qu'il a
        // acheté, même après téléchargement, longtemps après l'achat.
        const idsArticles = [...new Set((resa.items || []).map(i => i.id).filter(Boolean))];
        console.log('Facture', resa.code, '- ids articles à chercher :', idsArticles);
        if (idsArticles.length) {
            const { data: produits, error: errProduits } = await supabase.from('products').select('id, image_url').in('id', idsArticles);
            if (errProduits) console.error('Facture', resa.code, '- erreur recherche produits :', errProduits.message);
            console.log('Facture', resa.code, '- produits trouvés :', (produits || []).map(p => ({ id: p.id, image_url: p.image_url })));
            const imageParId = Object.fromEntries((produits || []).map(p => [p.id, p.image_url]));
            resa.items = (resa.items || []).map(i => ({ ...i, image_url: imageParId[i.id] || null }));
        }

        // L'email n'est pas stocké sur la commande elle-même — on le
        // retrouve via le profil pour les clients avec compte. Un achat
        // invité n'a jamais d'email (seuls nom + téléphone sont demandés),
        // la facture s'affiche alors simplement sans cette ligne.
        if (resa.utilisateur_id) {
            const { data: profil } = await supabase.from('utilisateurs').select('email').eq('id', resa.utilisateur_id).single();
            resa.email_client = profil?.email || null;
        }

        // Téléchargeable dans tous les cas désormais — le document précise
        // lui-même s'il s'agit d'une facture payée ou d'un simple suivi de
        // commande non payée.
        const pdf = await genererFacturePdf(resa);
        res.setHeader('Content-Type', 'application/pdf');
        const prefixe = (resa.statut === 'valide' || resa.statut === 'livre') ? 'facture' : 'suivi-commande';
        res.setHeader('Content-Disposition', `attachment; filename="${prefixe}-${resa.code}.pdf"`);
        return res.status(200).send(pdf);
    } catch (e) {
        console.error('Erreur facture:', e.message);
        return res.status(500).json({ error: 'Erreur serveur' });
    }
};

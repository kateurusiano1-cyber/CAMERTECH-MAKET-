// api/facture.js
// GET  : génère et renvoie le PDF (facture si payé, reçu de suivi marqué
//        "NON PAYÉ" sinon) — accès propriétaire (jeton Firebase) OU admin
//        (jeton admin).
// POST : masque/réaffiche une commande entière côté client (n'efface
//        jamais rien côté admin — juste sa visibilité dans "Mes commandes").

const { createClient } = require('@supabase/supabase-js');
const { verifierRequeteUtilisateur } = require('./_lib/verifierFirebaseToken');
const { verifierRequeteAdmin } = require('./_lib/adminSession');
const { genererFacturePdf } = require('./_lib/genererFacture');

module.exports = async (req, res) => {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    if (req.method === 'POST') {
        const uid = await verifierRequeteUtilisateur(req);
        if (!uid) return res.status(401).json({ error: 'Session invalide, reconnecte-toi' });
        try {
            const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
            const { code, masquer } = body || {};
            const { data: user } = await supabase.from('utilisateurs').select('id').eq('firebase_uid', uid).single();
            if (!user) return res.status(404).json({ error: 'Profil introuvable' });
            const { data: resa } = await supabase.from('reservations').select('utilisateur_id').eq('code', code).single();
            if (!resa || resa.utilisateur_id !== user.id) return res.status(403).json({ error: 'Cette commande ne vous appartient pas' });
            await supabase.from('reservations').update({ masquee_client: !!masquer }).eq('code', code);
            return res.status(200).json({ ok: true });
        } catch (e) {
            console.error('Erreur facture (masquage):', e.message);
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
            if (!uid) return res.status(401).json({ error: 'Session invalide, reconnecte-toi' });
            const { data: user } = await supabase.from('utilisateurs').select('id').eq('firebase_uid', uid).single();
            if (!user) return res.status(404).json({ error: 'Profil introuvable' });
            const { data: resaCheck } = await supabase.from('reservations').select('utilisateur_id').eq('code', code).single();
            if (!resaCheck || resaCheck.utilisateur_id !== user.id) return res.status(403).json({ error: 'Cette commande ne vous appartient pas' });
            autorise = true;
        }

        const { data: resa } = await supabase.from('reservations').select('*').eq('code', code).single();
        if (!resa) return res.status(404).json({ error: 'Commande introuvable' });

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

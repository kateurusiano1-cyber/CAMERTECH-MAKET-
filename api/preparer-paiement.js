// api/preparer-paiement.js
// Intégration du widget iKeePay exactement comme documentée par le
// fournisseur (iframe checkout/v1/inline). Le client ne transmet que le
// code de la commande déjà enregistrée ; le serveur relit son montant réel
// dans Supabase avant de donner le feu vert — le navigateur ne décide donc
// jamais lui-même du montant à payer.

const { createClient } = require('@supabase/supabase-js');
const { circuitOuvert, signalerEchec, signalerSucces } = require('./_lib/circuitBreaker');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { reference } = body || {};
        if (!reference) return res.status(400).json({ error: 'reference manquante' });

        const circuit = await circuitOuvert(supabase, 'ikeepay');
        if (circuit.ouvert) {
            return res.status(503).json({ error: `Paiement temporairement indisponible, réessayez dans ${Math.ceil(circuit.retryAfterSeconds / 60)} min.` });
        }

        if (!process.env.IKEEPAY_PUBLIC_KEY) {
            return res.status(500).json({ error: 'Clé iKeePay manquante côté serveur (IKEEPAY_PUBLIC_KEY)' });
        }

        // Seule source de vérité pour le montant : la commande déjà en base,
        // jamais une valeur envoyée par le navigateur.
        const { data: resa, error } = await supabase
            .from('reservations')
            .select('code, total, statut, utilisateur_id')
            .eq('code', reference)
            .single();

        if (error || !resa) return res.status(404).json({ error: 'Commande introuvable' });
        if (resa.statut === 'valide') return res.status(400).json({ error: 'Cette commande est déjà payée' });
        if (!resa.total || resa.total < 100) return res.status(400).json({ error: 'Montant de commande invalide' });

        // Email du client pour pré-remplir le widget, relu depuis son profil.
        let email = null;
        if (resa.utilisateur_id) {
            const { data: user } = await supabase.from('utilisateurs').select('email').eq('id', resa.utilisateur_id).single();
            email = user?.email || null;
        }

        await signalerSucces(supabase, 'ikeepay');

        return res.status(200).json({
            success: true,
            pk: process.env.IKEEPAY_PUBLIC_KEY,
            amount: Math.round(resa.total),
            currency: 'XAF', // le Cameroun utilise le XAF (franc CFA Afrique Centrale)
            order_id: resa.code,
            email
        });
    } catch (e) {
        console.error('Erreur preparer-paiement:', e.message);
        try { await signalerEchec(supabase, 'ikeepay'); } catch (_) {}
        return res.status(500).json({ error: e.message });
    }
};

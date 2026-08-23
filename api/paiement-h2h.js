// api/paiement-h2h.js
// Alternative au widget (api/preparer-paiement.js) : appelle directement
// l'API serveur-à-serveur d'iKeePay (POST /h2h-payin) avec la clé secrète,
// jamais exposée au navigateur. Le client fournit juste son numéro et son
// opérateur ; le montant, lui, est toujours relu depuis la vraie commande
// en base — jamais depuis ce qu'enverrait le navigateur.

const { createClient } = require('@supabase/supabase-js');
const { circuitOuvert, signalerEchec, signalerSucces } = require('./_lib/circuitBreaker');

const OPERATEURS_VALIDES = ['MTN', 'ORANGE'];

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { reference, telephone, operateur } = body || {};

        if (!reference) return res.status(400).json({ error: 'reference manquante' });
        if (!telephone || !/^6\d{8}$/.test(telephone)) return res.status(400).json({ error: 'Numéro de téléphone invalide' });
        const op = String(operateur || '').toUpperCase();
        if (!OPERATEURS_VALIDES.includes(op)) return res.status(400).json({ error: 'Opérateur invalide' });

        if (!process.env.IKEEPAY_SECRET_KEY) {
            return res.status(500).json({ error: 'Clé secrète iKeePay manquante côté serveur (IKEEPAY_SECRET_KEY)' });
        }

        const circuit = await circuitOuvert(supabase, 'ikeepay');
        if (circuit.ouvert) {
            return res.status(503).json({ error: `Paiement temporairement indisponible, réessayez dans ${Math.ceil(circuit.retryAfterSeconds / 60)} min.` });
        }

        // Seule source de vérité pour le montant : la commande déjà en base.
        const { data: resa, error } = await supabase
            .from('reservations')
            .select('code, total, statut, utilisateur_id')
            .eq('code', reference)
            .single();

        if (error || !resa) return res.status(404).json({ error: 'Commande introuvable' });
        if (resa.statut === 'valide') return res.status(400).json({ error: 'Cette commande est déjà payée' });
        if (!resa.total || resa.total < 100) return res.status(400).json({ error: 'Montant de commande invalide' });

        let email = 'client@camertech-maket.vercel.app';
        if (resa.utilisateur_id) {
            const { data: user } = await supabase.from('utilisateurs').select('email').eq('id', resa.utilisateur_id).single();
            if (user?.email) email = user.email;
        }

        const reponse = await fetch('https://api.ikeepay.com/h2h-payin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.IKEEPAY_SECRET_KEY },
            body: JSON.stringify({
                amount: Math.round(resa.total),
                currency: 'XAF',
                country: 'CM',
                phoneNumber: '237' + telephone,
                operator: op,
                external_reference: resa.code,
                customer_email: email
            })
        });
        const data = await reponse.json();

        if (!reponse.ok) {
            console.error('Erreur iKeePay H2H:', reponse.status, data);
            await signalerEchec(supabase, 'ikeepay');
            return res.status(502).json({ error: data?.message || data?.error || 'Le paiement a été refusé par iKeePay' });
        }

        await signalerSucces(supabase, 'ikeepay');
        // payment_link : présent uniquement pour Wave/Orange dans certains cas
        // (voir doc iKeePay) — le client sera redirigé dessus si fourni.
        return res.status(200).json({ success: true, payment_link: data?.payment_link || null, reference: resa.code });
    } catch (e) {
        console.error('Erreur paiement-h2h:', e.message);
        try { await signalerEchec(supabase, 'ikeepay'); } catch (_) {}
        return res.status(500).json({ error: 'Erreur serveur' });
    }
};

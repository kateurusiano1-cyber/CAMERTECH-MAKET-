// api/webhook-ikeepay.js
// Reçoit la notification de paiement d'iKeePay. Leur documentation ne
// décrit aucune signature cryptographique pour ce webhook (contrairement à
// GeniusPay qui utilisait du HMAC-SHA256) — deux protections sont donc
// appliquées ici en attendant confirmation de leur support technique :
//   1. Un secret partagé dans l'URL du webhook (?s=...), à configurer côté
//      iKeePay, que seul notre serveur et iKeePay connaissent.
//   2. Le montant reçu est TOUJOURS revérifié contre le vrai montant de la
//      commande en base avant validation — jamais fait confiance au champ
//      "amount" du webhook seul. En cas d'écart, la commande n'est PAS
//      validée automatiquement (elle reste "paiement_en_cours" pour
//      vérification manuelle), et l'incident est journalisé.

const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const secretAttendu = process.env.IKEEPAY_WEBHOOK_SECRET;
        const secretRecu = req.query?.s;
        if (!secretAttendu || !secretRecu || secretRecu !== secretAttendu) {
            console.error('Webhook iKeePay: secret manquant ou invalide');
            return res.status(401).json({ error: 'Non autorisé' });
        }

        const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

        // Deux formats possibles selon le mode utilisé (widget ou H2H) — on
        // les ramène tous les deux à la même forme avant de continuer.
        const estH2H = !!payload?.data;
        const orderId = estH2H ? payload.data.external_reference : payload?.order_id;
        const statutRecu = estH2H ? payload.data.status : payload?.status;
        const montantRecu = Number(estH2H ? payload.data.amount : payload?.amount);
        const refFournisseur = estH2H ? payload.data.provider_reference : payload?.ikeepay_ref;
        console.log(`Webhook iKeePay reçu (${estH2H ? 'H2H' : 'widget'}): event=${payload?.event} order_id=${orderId} statut=${statutRecu} amount=${montantRecu}`);

        if (!orderId) return res.status(200).json({ received: true }); // rien à traiter

        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const { data: resa } = await supabase.from('reservations').select('*').eq('code', orderId).single();

        if (!resa) {
            console.error(`Webhook iKeePay: commande ${orderId} introuvable`);
            return res.status(200).json({ received: true });
        }

        // Idempotence : déjà traité, on ignore silencieusement les doublons.
        if (resa.statut === 'valide') return res.status(200).json({ received: true });

        const succes = payload?.event === 'payment.success' || statutRecu === 'completed';

        if (succes) {
            // Le cœur de la protection : le montant payé doit correspondre
            // exactement au montant réel de la commande en base.
            if (!montantRecu || Math.round(montantRecu) !== Math.round(resa.total)) {
                console.error(`⚠️ ALERTE écart de montant sur ${orderId} : reçu=${montantRecu} attendu=${resa.total} — commande NON validée automatiquement`);
                return res.status(200).json({ received: true, warning: 'amount_mismatch' });
            }
            await supabase.from('reservations').update({
                statut: 'valide',
                transaction_id: refFournisseur || null,
                paye_le: new Date().toISOString()
            }).eq('code', orderId);
            // (Envoi automatique de la facture par email désactivé pour
            // l'instant — reste disponible via le bouton de téléchargement
            // côté client et côté admin.)
        } else if (statutRecu === 'failed' || statutRecu === 'expired' || payload?.event === 'payment.failed') {
            await supabase.from('reservations').update({ statut: 'paiement_echoue' }).eq('code', orderId);
        }

        return res.status(200).json({ received: true });
    } catch (error) {
        console.error('Erreur webhook iKeePay:', error);
        return res.status(500).json({ error: 'Erreur serveur' });
    }
};

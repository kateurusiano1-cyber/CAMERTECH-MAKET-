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
const { envoyerPushUtilisateur, envoyerPushAdmins } = require('./_lib/envoyerPush');
const CONFIG = require('../config.js');

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

        // Le format réel observé (confirmé via un test webhook.site) montre
        // que le mode widget imbrique AUSSI les champs sous "data", avec des
        // noms différents du mode H2H supposé au départ (order_id/reference
        // au lieu de external_reference/provider_reference). On ne peut donc
        // pas se fier à la simple présence de "data" pour deviner le format :
        // on cherche chaque champ dans les deux emplacements possibles.
        const d = payload?.data || {};
        const orderId = d.order_id || d.external_reference || payload?.order_id;
        const statutRecu = d.status ?? payload?.status;
        const montantRecu = Number(d.amount ?? payload?.amount);
        const refFournisseur = d.reference || d.provider_reference || payload?.ikeepay_ref;
        console.log(`Webhook iKeePay reçu: event=${payload?.event} order_id=${orderId} statut=${statutRecu} amount=${montantRecu}`);

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
            // Date limite de retrait (7 jours), uniquement pour les commandes
            // à retirer en agence — jamais pour une livraison à domicile.
            const estRetraitAgence = !CONFIG.ZONES_COUVERTES.includes(resa.zone_livraison);
            const dateLimiteRetrait = estRetraitAgence ? new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString() : null;

            await supabase.from('reservations').update({
                statut: 'valide',
                transaction_id: refFournisseur || null,
                paye_le: new Date().toISOString(),
                date_limite_retrait: dateLimiteRetrait
            }).eq('code', orderId);
            // (Envoi automatique de la facture par email désactivé pour
            // l'instant — reste disponible via le bouton de téléchargement
            // côté client et côté admin.)
            try {
                await envoyerPushUtilisateur(supabase, resa.utilisateur_id, {
                    titre: '✅ Commande validée !',
                    corps: `Ta commande ${resa.code} est confirmée (${Math.round(resa.total)} FCFA).`,
                    url: '/'
                });
            } catch (e) { console.error('Erreur push validation:', e.message); }
            // Prévient l'équipe en boutique qu'une commande payée est à
            // préparer (empaquetage / livraison) — n'existait pas du tout
            // jusqu'ici, la validation d'une commande ne déclenchait aucune
            // alerte côté boutique.
            try {
                await envoyerPushAdmins(supabase, {
                    titre: '📦 Nouvelle commande à préparer',
                    corps: `${resa.code} — ${resa.nom_client} — ${Math.round(resa.total)} FCFA — ${estRetraitAgence ? 'Retrait en agence' : 'Livraison à ' + resa.zone_livraison}`,
                    url: '/admin-cmr2025'
                });
            } catch (e) { console.error('Erreur push admins:', e.message); }
            // Crédit des points de fidélité (1 point / 1000 FCFA), jamais
            // pour un achat invité (pas de compte = pas d'historique de
            // points, comme déjà documenté). Ne bloque jamais la validation
            // de la commande si ça échoue.
            if (resa.utilisateur_id) {
                const pointsGagnes = Math.floor(resa.total / 1000);
                if (pointsGagnes > 0) {
                    try {
                        const { data: u } = await supabase.from('utilisateurs').select('points').eq('id', resa.utilisateur_id).single();
                        await supabase.from('utilisateurs').update({ points: (u?.points || 0) + pointsGagnes }).eq('id', resa.utilisateur_id);
                    } catch (e) { console.error('Erreur crédit points fidélité:', e.message); }
                }
            }
        } else if (statutRecu === 'failed' || statutRecu === 'expired' || payload?.event === 'payment.failed') {
            await supabase.from('reservations').update({ statut: 'paiement_echoue' }).eq('code', orderId);
        }

        return res.status(200).json({ received: true });
    } catch (error) {
        console.error('Erreur webhook iKeePay:', error);
        return res.status(500).json({ error: 'Erreur serveur' });
    }
};

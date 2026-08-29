// api/relance-panier.js
// Appelée régulièrement par un service de cron GRATUIT externe (ex:
// cron-job.org), toutes les 1-5 minutes — Vercel Hobby ne permet pas de
// cron interne plus fréquent qu'une fois par jour. Protégée par un secret
// dans l'URL, même principe que le webhook de paiement.
//
// Cherche les commandes en attente de paiement depuis plus d'1 minute,
// jamais relancées, et envoie une notification push de rappel — une seule
// fois par commande (colonne relance_envoyee).

const { createClient } = require('@supabase/supabase-js');
const { envoyerPushUtilisateur } = require('./_lib/envoyerPush');

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    const secretAttendu = process.env.RELANCE_PANIER_SECRET;
    const secretRecu = req.query?.s;
    if (!secretAttendu || !secretRecu || secretRecu !== secretAttendu) {
        return res.status(401).json({ error: 'Non autorisé' });
    }

    try {
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        const seuil = new Date(Date.now() - 60 * 1000).toISOString(); // plus d'1 minute

        const { data: paniers, error } = await supabase
            .from('reservations')
            .select('id, code, total, utilisateur_id')
            .eq('statut', 'paiement_en_cours')
            .eq('relance_envoyee', false)
            .not('utilisateur_id', 'is', null)
            .lt('created_at', seuil)
            .limit(50);

        if (error) throw error;
        if (!paniers?.length) return res.status(200).json({ traitees: 0 });

        for (const p of paniers) {
            try {
                await envoyerPushUtilisateur(supabase, p.utilisateur_id, {
                    titre: '👀 Tu as oublié quelque chose',
                    corps: `Ta commande ${p.code} (${Math.round(p.total)} FCFA) t'attend dans ton panier !`,
                    url: '/'
                });
            } catch (e) {
                console.error(`Erreur push relance ${p.code}:`, e.message);
            }
            await supabase.from('reservations').update({ relance_envoyee: true }).eq('id', p.id);
        }

        return res.status(200).json({ traitees: paniers.length });
    } catch (e) {
        console.error('Erreur relance-panier:', e.message);
        return res.status(500).json({ error: 'Erreur serveur' });
    }
};

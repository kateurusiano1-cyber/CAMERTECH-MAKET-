// api/_lib/envoyerPush.js
// Envoie une notification push à tous les appareils abonnés d'un client.
// Un abonnement expiré/invalide (client désinstallé, permission révoquée)
// est automatiquement retiré de la base au passage.

const webpush = require('web-push');

function configurerVapid() {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
        throw new Error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY manquants côté serveur');
    }
    webpush.setVapidDetails(
        'mailto:contact@camertechmarket.com',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
}

async function envoyerPushUtilisateur(supabase, utilisateurId, { titre, corps, url }) {
    if (!utilisateurId) return;
    configurerVapid();

    const { data: abonnements } = await supabase.from('push_subscriptions').select('*').eq('utilisateur_id', utilisateurId);
    if (!abonnements || !abonnements.length) return;

    const payload = JSON.stringify({ titre, corps, url: url || '/' });

    await Promise.all(abonnements.map(async (abo) => {
        try {
            await webpush.sendNotification({
                endpoint: abo.endpoint,
                keys: { p256dh: abo.p256dh, auth: abo.auth }
            }, payload);
        } catch (e) {
            // 404/410 = abonnement mort (désinstallé, permission révoquée) : on le retire.
            if (e.statusCode === 404 || e.statusCode === 410) {
                await supabase.from('push_subscriptions').delete().eq('endpoint', abo.endpoint);
            } else {
                console.error('Erreur envoi push:', e.message);
            }
        }
    }));
}

module.exports = { envoyerPushUtilisateur };

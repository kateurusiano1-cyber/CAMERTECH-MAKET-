// api/webhook-monetbil.js
// Reçoit les notifications de paiement de Monetbil (Vercel)
// Met à jour la commande dans Supabase automatiquement

const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Monetbil envoie en form-urlencoded ou déjà parsé par Vercel selon le content-type
    const raw = typeof req.body === 'string' ? req.body : null;
    const params = raw ? new URLSearchParams(raw) : new URLSearchParams(req.body || {});

    const status = params.get ? params.get('status') : req.body.status;
    const transaction_id = params.get ? params.get('transaction_id') : req.body.transaction_id;
    const payment_ref = params.get ? params.get('payment_ref') : req.body.payment_ref; // référence CMT-XXX-XXXX
    const service_key = params.get ? params.get('service_key') : req.body.service_key;

    // Vérifier que la requête vient bien de Monetbil
    if (service_key !== process.env.MONETBIL_SERVICE_KEY) {
      console.error('Clé service invalide dans webhook');
      return res.status(401).json({ error: 'Non autorisé' });
    }

    console.log(`Webhook Monetbil reçu: ref=${payment_ref} status=${status}`);

    // Connexion Supabase avec la clé service (admin)
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    if (status === 'success') {
      const { error } = await supabase
        .from('reservations')
        .update({
          statut: 'valide',
          transaction_id: transaction_id,
          paye_le: new Date().toISOString()
        })
        .eq('code', payment_ref);

      if (error) {
        console.error('Erreur mise à jour Supabase:', error);
      } else {
        console.log(`Commande ${payment_ref} validée avec succès`);
      }
    } else if (status === 'failed' || status === 'cancelled') {
      await supabase
        .from('reservations')
        .update({ statut: 'paiement_echoue' })
        .eq('code', payment_ref);
    }

    return res.status(200).json({ received: true, status });

  } catch (error) {
    console.error('Erreur webhook:', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

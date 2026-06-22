// netlify/functions/webhook-monetbil.js
// Reçoit les notifications de paiement de Monetbil
// Met à jour la commande dans Supabase automatiquement

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method not allowed' };
  }

  try {
    // Parser le body (Monetbil envoie en form-urlencoded)
    const params = new URLSearchParams(event.body);
    const status = params.get('status');
    const transaction_id = params.get('transaction_id');
    const payment_ref = params.get('payment_ref'); // Notre référence CMT-XXX-XXXX
    const amount = params.get('amount');
    const service_key = params.get('service_key');

    // Vérifier que la requête vient bien de Monetbil
    if (service_key !== process.env.MONETBIL_SERVICE_KEY) {
      console.error('Clé service invalide dans webhook');
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Non autorisé' }) };
    }

    console.log(`Webhook Monetbil reçu: ref=${payment_ref} status=${status}`);

    // Connexion Supabase avec la clé service (admin)
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    if (status === 'success') {
      // Paiement réussi → mettre à jour la commande
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
      // Paiement échoué → mettre à jour le statut
      await supabase
        .from('reservations')
        .update({ statut: 'paiement_echoue' })
        .eq('code', payment_ref);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ received: true, status })
    };

  } catch (error) {
    console.error('Erreur webhook:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Erreur serveur' })
    };
  }
};

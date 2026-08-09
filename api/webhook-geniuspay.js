// api/webhook-geniuspay.js
// Reçoit les notifications de paiement de GeniusPay et met à jour la commande
// dans Supabase automatiquement. Vérifie la signature HMAC-SHA256 comme
// exigé par leur documentation, pour s'assurer que la requête vient bien
// de GeniusPay et n'a pas été forgée par quelqu'un d'autre.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const event = req.headers['x-webhook-event'];

    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    const secret = process.env.GENIUSPAY_WEBHOOK_SECRET;
    if (!secret) {
      console.error('GENIUSPAY_WEBHOOK_SECRET manquant');
      return res.status(500).json({ error: 'Config manquante' });
    }

    // Vérification de la signature
    const dataToSign = `${timestamp}.${JSON.stringify(payload)}`;
    const expectedSignature = crypto.createHmac('sha256', secret).update(dataToSign).digest('hex');

    if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      console.error('Signature webhook invalide');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Protection anti-rejeu (5 min)
    if (timestamp && Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) {
      return res.status(400).json({ error: 'Timestamp too old' });
    }

    const tx = payload.data;
    const orderId = tx?.metadata?.order_id;
    console.log(`Webhook GeniusPay reçu: event=${event} ref=${tx?.reference} order_id=${orderId} statut=${tx?.status}`);

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    if (orderId) {
      if (event === 'payment.success' || tx?.status === 'completed') {
        await supabase.from('reservations').update({
          statut: 'valide',
          transaction_id: tx.reference,
          paye_le: new Date().toISOString()
        }).eq('code', orderId);
      } else if (event === 'payment.failed' || event === 'payment.cancelled' || event === 'payment.expired') {
        await supabase.from('reservations').update({ statut: 'paiement_echoue' }).eq('code', orderId);
      }
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Erreur webhook GeniusPay:', error);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

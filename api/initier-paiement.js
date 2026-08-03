const { createClient } = require('@supabase/supabase-js');
const { circuitOuvert, signalerEchec, signalerSucces } = require('./_lib/circuitBreaker');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { telephone, montant, operateur, reference, nom_client } = body || {};

    if (!telephone || !montant || !operateur || !reference) {
      return res.status(400).json({ error: 'Paramètres manquants' });
    }

    if (montant < 100 || montant > 5000000) {
      return res.status(400).json({ error: 'Montant invalide' });
    }

    // Circuit breaker : si Monetbil échoue en boucle, on arrête de le solliciter un moment
    const circuit = await circuitOuvert(supabase, 'monetbil');
    if (circuit.ouvert) {
      return res.status(503).json({ error: `Paiement temporairement indisponible, réessayez dans ${Math.ceil(circuit.retryAfterSeconds / 60)} min.` });
    }

    const serviceKey = process.env.MONETBIL_SERVICE_KEY;
    if (!serviceKey) {
      return res.status(500).json({ error: 'Clé Monetbil manquante' });
    }

    const url = `https://api.monetbil.com/widget/v2.1/${serviceKey}`;

    const params = new URLSearchParams({
      amount: Math.round(montant).toString(),
      phone: '237' + telephone,
      phone_lock: 'true',
      locale: 'fr',
      operator: operateur === 'mtn' ? 'CM_MTNMOBILEMONEY' : 'CM_ORANGEMONEY',
      country: 'CM',
      currency: 'XAF',
      payment_ref: reference,
      first_name: nom_client || 'Client'
    });

    const response = await fetch(url, {
      method: 'POST',
      body: params.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      }
    });

    const rawText = await response.text();
    console.log('Status:', response.status);
    console.log('Response:', rawText.substring(0, 300));

    let result;
    try {
      result = JSON.parse(rawText);
    } catch (e) {
      await signalerEchec(supabase, 'monetbil');
      return res.status(500).json({ error: 'Réponse invalide: ' + rawText.substring(0, 100) });
    }

    await signalerSucces(supabase, 'monetbil');

    return res.status(200).json({
      success: result.status === 'success' || result.status === 1 || !!result.transaction_id,
      transaction_id: result.transaction_id || null,
      message: result.message || null,
      status: result.status || null
    });

  } catch (error) {
    console.error('Erreur:', error.message);
    try { await signalerEchec(supabase, 'monetbil'); } catch (e) {}
    return res.status(500).json({ error: error.message });
  }
};

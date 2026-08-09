// api/initier-paiement.js
// Initie un paiement Mobile Money via GeniusPay (remplace Monetbil).
// Mode "MMO explicite" : on force l'opérateur choisi par le client (MTN/Orange)
// via PawaPay, ce qui est la voie la plus fiable pour le Cameroun d'après la
// documentation GeniusPay (couverture confirmée : MTN_MOMO_CMR, ORANGE_CMR).

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
    if (montant < 200 || montant > 5000000) {
      return res.status(400).json({ error: 'Montant invalide' });
    }

    // Circuit breaker : si GeniusPay échoue en boucle, on arrête de le solliciter un moment
    const circuit = await circuitOuvert(supabase, 'geniuspay');
    if (circuit.ouvert) {
      return res.status(503).json({ error: `Paiement temporairement indisponible, réessayez dans ${Math.ceil(circuit.retryAfterSeconds / 60)} min.` });
    }

    if (!process.env.GENIUSPAY_API_KEY || !process.env.GENIUSPAY_API_SECRET) {
      return res.status(500).json({ error: 'Clés GeniusPay manquantes côté serveur' });
    }

    const mmoProvider = operateur === 'mtn' ? 'MTN_MOMO_CMR' : 'ORANGE_CMR';
    const origin = `https://${req.headers.host}`;

    const payload = {
      amount: Math.round(montant),
      currency: 'XAF',
      payment_method: 'pawapay',
      mmo_provider: mmoProvider,
      description: `Commande CAMERTECH MARKET ${reference}`,
      customer: {
        name: nom_client || 'Client',
        phone: '+237' + telephone,
        country: 'CM'
      },
      metadata: { order_id: reference },
      success_url: `${origin}/?paiement=retour&ref=${reference}`,
      error_url: `${origin}/?paiement=retour&ref=${reference}`
    };

    const response = await fetch('https://geniuspay.ci/api/v1/merchant/payments', {
      method: 'POST',
      headers: {
        'X-API-Key': process.env.GENIUSPAY_API_KEY,
        'X-API-Secret': process.env.GENIUSPAY_API_SECRET,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const rawText = await response.text();
    console.log('GeniusPay HTTP status:', response.status);
    console.log('GeniusPay response (extrait):', rawText.substring(0, 500));

    let result;
    try {
      result = JSON.parse(rawText);
    } catch (e) {
      await signalerEchec(supabase, 'geniuspay');
      return res.status(502).json({ error: `GeniusPay a répondu HTTP ${response.status} avec un contenu non-JSON : ${rawText.substring(0, 200)}` });
    }

    if (!response.ok || !result.success) {
      await signalerEchec(supabase, 'geniuspay');
      return res.status(500).json({ error: result.error?.message || `Échec initialisation paiement (HTTP ${response.status})` });
    }

    await signalerSucces(supabase, 'geniuspay');

    return res.status(200).json({
      success: true,
      payment_url: result.data.payment_url,
      geniuspay_reference: result.data.reference,
      status: result.data.status
    });

  } catch (error) {
    console.error('Erreur:', error.message);
    try { await signalerEchec(supabase, 'geniuspay'); } catch (e) {}
    return res.status(500).json({ error: error.message });
  }
};

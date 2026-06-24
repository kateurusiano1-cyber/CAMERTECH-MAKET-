// netlify/functions/initier-paiement.js
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode non autorisée' }) };

  try {
    const body = JSON.parse(event.body);
    const { telephone, montant, operateur, reference, nom_client } = body;

    if (!telephone || !montant || !operateur || !reference) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Paramètres manquants' }) };
    }

    if (montant < 100 || montant > 5000000) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Montant invalide' }) };
    }

    const serviceKey = process.env.MONETBIL_SERVICE_KEY;
    if (!serviceKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Clé Monetbil manquante' }) };
    }

    // Utiliser le widget URL de Monetbil (plus fiable)
    const params = new URLSearchParams({
      service_key: serviceKey,
      phonenumber: '237' + telephone,
      amount: Math.round(montant).toString(),
      currency: 'XAF',
      payment_ref: reference,
      first_name: nom_client || 'Client',
      country: 'CM',
      operator: operateur === 'mtn' ? 'CM_MTN' : 'CM_ORANGE'
    });

    const response = await fetch('https://api.monetbil.com/payment/v1/request', {
      method: 'POST',
      body: params.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      }
    });

    // Lire la réponse comme texte d'abord
    const rawText = await response.text();
    console.log('Monetbil raw response:', rawText.substring(0, 200));

    let result;
    try {
      result = JSON.parse(rawText);
    } catch(e) {
      console.error('Monetbil HTML response:', rawText.substring(0, 500));
      // Monetbil a renvoyé du HTML — essayer l'autre endpoint
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Réponse invalide de Monetbil', raw: rawText.substring(0, 100) }) };
    }

    console.log('Monetbil result:', JSON.stringify(result));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: result.status === 'success' || result.status === 1 || !!result.transaction_id,
        transaction_id: result.transaction_id || result.transaction?.transaction_id || null,
        message: result.message || null,
        status: result.status || null
      })
    };

  } catch (error) {
    console.error('Erreur paiement:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Erreur: ' + error.message })
    };
  }
};

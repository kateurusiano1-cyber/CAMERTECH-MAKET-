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
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Réponse invalide: ' + rawText.substring(0, 100) }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: result.status === 'success' || result.status === 1 || !!result.transaction_id,
        transaction_id: result.transaction_id || null,
        message: result.message || null,
        status: result.status || null
      })
    };

  } catch (error) {
    console.error('Erreur:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};

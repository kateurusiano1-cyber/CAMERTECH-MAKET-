// netlify/functions/initier-paiement.js
// Fonction backend sécurisée — clés jamais exposées au client

exports.handler = async (event) => {
  // CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { telephone, montant, operateur, reference, nom_client } = body;

    // Validation côté serveur
    if (!telephone || !montant || !operateur || !reference) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Paramètres manquants' })
      };
    }

    if (!/^\d{9}$/.test(telephone)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Numéro de téléphone invalide' })
      };
    }

    if (montant < 100 || montant > 5000000) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Montant invalide' })
      };
    }

    // Clés secrètes lues depuis les variables d'environnement Netlify
    const serviceKey = process.env.MONETBIL_SERVICE_KEY;
    const serviceSecret = process.env.MONETBIL_SERVICE_SECRET;

    if (!serviceKey || !serviceSecret) {
      console.error('Clés Monetbil manquantes dans les variables d\'environnement');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Configuration serveur incorrecte' })
      };
    }

    // Appel API Monetbil — fait côté serveur uniquement
    const formData = new URLSearchParams();
    formData.append('service_key', serviceKey);
    formData.append('phonenumber', '237' + telephone);
    formData.append('amount', Math.round(montant));
    formData.append('currency', 'XAF');
    formData.append('payment_ref', reference);
    formData.append('first_name', nom_client || 'Client');
    formData.append('country', 'CM');
    formData.append('operator', operateur === 'mtn' ? 'CM_MTN' : 'CM_ORANGE');
    formData.append('notify_url', process.env.URL + '/.netlify/functions/webhook-monetbil');

    const response = await fetch('https://api.monetbil.com/payment/v1/request', {
      method: 'POST',
      body: formData,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const result = await response.json();

    // On renvoie seulement ce dont le client a besoin
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: result.status === 'success' || !!result.transaction,
        transaction_id: result.transaction?.transaction_id || null,
        message: result.message || null,
        status: result.status || null
      })
    };

  } catch (error) {
    console.error('Erreur paiement:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Erreur serveur interne' })
    };
  }
};

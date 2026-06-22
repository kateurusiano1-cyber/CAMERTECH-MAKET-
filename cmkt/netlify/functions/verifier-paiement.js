// netlify/functions/verifier-paiement.js
// Vérification du statut d'une transaction Monetbil

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { transaction_id } = JSON.parse(event.body || '{}');
    if (!transaction_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'transaction_id manquant' }) };

    const formData = new URLSearchParams();
    formData.append('service_key', process.env.MONETBIL_SERVICE_KEY);
    formData.append('transaction_id', transaction_id);

    const response = await fetch('https://api.monetbil.com/payment/v1/checkPayment', {
      method: 'POST',
      body: formData,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const result = await response.json();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: result.status,
        transaction_status: result.transaction?.status,
        amount: result.transaction?.amount
      })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

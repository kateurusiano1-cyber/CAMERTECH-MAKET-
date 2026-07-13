// api/verifier-paiement.js
// Vérification du statut d'une transaction Monetbil (Vercel)

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { transaction_id } = body;
    if (!transaction_id) return res.status(400).json({ error: 'transaction_id manquant' });

    const formData = new URLSearchParams();
    formData.append('service_key', process.env.MONETBIL_SERVICE_KEY);
    formData.append('transaction_id', transaction_id);

    const response = await fetch('https://api.monetbil.com/payment/v1/checkPayment', {
      method: 'POST',
      body: formData,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const result = await response.json();

    return res.status(200).json({
      status: result.status,
      transaction_status: result.transaction?.status,
      amount: result.transaction?.amount
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

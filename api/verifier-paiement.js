// api/verifier-paiement.js
// Vérifie le statut d'une transaction GeniusPay via sa référence (MTX-...).

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { reference } = body;
    if (!reference) return res.status(400).json({ error: 'reference manquante' });

    if (!process.env.GENIUSPAY_API_KEY || !process.env.GENIUSPAY_API_SECRET) {
      return res.status(500).json({ error: 'Clés GeniusPay manquantes côté serveur' });
    }

    const response = await fetch(`https://pay.genius.ci/api/v1/merchant/payments/${encodeURIComponent(reference)}`, {
      headers: {
        'X-API-Key': process.env.GENIUSPAY_API_KEY,
        'X-API-Secret': process.env.GENIUSPAY_API_SECRET
      }
    });

    const result = await response.json();
    if (!response.ok || !result.success) {
      return res.status(404).json({ error: result.error?.message || 'Transaction introuvable' });
    }

    return res.status(200).json({
      status: result.data.status, // pending | processing | completed | failed | expired
      amount: result.data.amount,
      order_id: result.data.metadata?.order_id || null
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

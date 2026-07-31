// api/analyser-produit.js
// Reçoit une photo de produit, demande à Claude (API Anthropic) d'en déduire
// un nom, une catégorie et une description. L'admin garde la main sur le
// prix et la quantité, jamais devinés par l'IA.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { image_base64, media_type } = body || {};
    if (!image_base64) return res.status(400).json({ error: 'Image manquante' });
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "Clé IA non configurée côté serveur (ANTHROPIC_API_KEY manquante dans Vercel)" });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: image_base64 } },
            {
              type: 'text',
              text: 'Regarde cette photo d\'un produit tech destiné à une boutique en ligne au Cameroun (CAMERTECH MARKET). Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour, exactement sous cette forme : {"name":"nom court et vendeur du produit, en français","category":"une seule valeur parmi : Téléphonie, Accessoires, Électronique, Réseau, Gaming, Autre","description":"description commerciale de 1 à 2 phrases en français, sans inventer de caractéristiques techniques précises que tu ne peux pas voir sur la photo"}'
            }
          ]
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || 'Erreur API IA' });
    }
    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch (e) { return res.status(500).json({ error: "Réponse IA illisible, réessaie" }); }

    return res.status(200).json(parsed);
  } catch (e) {
    console.error('Erreur analyser-produit:', e);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

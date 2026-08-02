// api/analyser-produit.js
// Reçoit une photo de produit, demande à Gemini (API Google, gratuite) d'en
// déduire un nom, une catégorie et une description. L'admin garde la main
// sur le prix et la quantité, jamais devinés par l'IA.

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    // Nouveau format : { images: [{data, media_type}, ...] }
    // Rétro-compatible avec l'ancien format à une seule image.
    let images = body?.images;
    if (!images && body?.image_base64) images = [{ data: body.image_base64, media_type: body.media_type }];
    if (!images || !images.length) return res.status(400).json({ error: 'Image manquante' });
    if (images.length > 5) images = images.slice(0, 5); // évite les requêtes trop lourdes

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Clé IA non configurée côté serveur (GEMINI_API_KEY manquante dans Vercel)" });
    }

    const prompt = images.length > 1
      ? `Regarde ces ${images.length} photos du MÊME produit tech (sous différents angles) destiné à une boutique en ligne au Cameroun (CAMERTECH MARKET). Combine les informations visibles sur toutes les photos. Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour, exactement sous cette forme : {"name":"nom court et vendeur du produit, en français","category":"une seule valeur parmi : Téléphonie, Accessoires, Électronique, Réseau, Gaming, Autre","description":"description commerciale de 1 à 2 phrases en français, sans inventer de caractéristiques techniques précises que tu ne peux pas voir sur les photos"}`
      : 'Regarde cette photo d\'un produit tech destiné à une boutique en ligne au Cameroun (CAMERTECH MARKET). Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour, exactement sous cette forme : {"name":"nom court et vendeur du produit, en français","category":"une seule valeur parmi : Téléphonie, Accessoires, Électronique, Réseau, Gaming, Autre","description":"description commerciale de 1 à 2 phrases en français, sans inventer de caractéristiques techniques précises que tu ne peux pas voir sur la photo"}';

    const parts = [
      { text: prompt },
      ...images.map(img => ({ inline_data: { mime_type: img.media_type || 'image/jpeg', data: img.data } }))
    ];

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] })
      }
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || 'Erreur API IA' });
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
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

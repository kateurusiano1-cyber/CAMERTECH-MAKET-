// api/analyser-produit.js
// Reçoit une photo de produit, demande à Gemini (API Google, gratuite) d'en
// déduire un nom, une catégorie et une description. L'admin garde la main
// sur le prix et la quantité, jamais devinés par l'IA.

const { createClient } = require('@supabase/supabase-js');
const { circuitOuvert, signalerEchec, signalerSucces } = require('./_lib/circuitBreaker');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    // Nouveau format : { images: [{data, media_type}, ...], mode: 'unique' | 'lot' }
    // Rétro-compatible avec l'ancien format à une seule image.
    let images = body?.images;
    if (!images && body?.image_base64) images = [{ data: body.image_base64, media_type: body.media_type }];
    if (!images || !images.length) return res.status(400).json({ error: 'Image manquante' });
    if (images.length > 8) images = images.slice(0, 8); // évite les requêtes trop lourdes
    const modeLot = body?.mode === 'lot';

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Clé IA non configurée côté serveur (GEMINI_API_KEY manquante dans Vercel)" });
    }

    // Circuit breaker : si Gemini échoue/quota dépassé en boucle, on arrête de le solliciter un moment
    const circuit = await circuitOuvert(supabase, 'gemini');
    if (circuit.ouvert) {
      return res.status(503).json({ error: `IA temporairement indisponible (quota ou panne), réessayez dans ${Math.ceil(circuit.retryAfterSeconds / 60)} min.` });
    }

    const champsJson = '{"name":"nom court et vendeur du produit, en français","category":"une seule valeur parmi : Téléphonie, Accessoires, Électronique, Réseau, Gaming, Autre","description":"description commerciale de 1 à 2 phrases en français, sans inventer de caractéristiques techniques précises que tu ne peux pas voir sur la photo"}';

    let prompt;
    if (modeLot) {
      prompt = `Voici ${images.length} photos de ${images.length} PRODUITS TECH DIFFÉRENTS (une photo = un produit distinct, dans l'ordre exact où elles sont fournies), destinés à une boutique en ligne au Cameroun (CAMERTECH MARKET). Analyse chaque photo indépendamment. Réponds UNIQUEMENT avec un tableau JSON valide de ${images.length} objets, un par photo dans le même ordre, sans aucun texte autour, chaque objet exactement sous cette forme : ${champsJson}`;
    } else if (images.length > 1) {
      prompt = `Regarde ces ${images.length} photos du MÊME produit tech (sous différents angles) destiné à une boutique en ligne au Cameroun (CAMERTECH MARKET). Combine les informations visibles sur toutes les photos. Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour, exactement sous cette forme : ${champsJson}`;
    } else {
      prompt = `Regarde cette photo d'un produit tech destiné à une boutique en ligne au Cameroun (CAMERTECH MARKET). Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour, exactement sous cette forme : ${champsJson}`;
    }

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
      await signalerEchec(supabase, 'gemini');
      return res.status(500).json({ error: data.error?.message || 'Erreur API IA' });
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(clean); }
    catch (e) { await signalerEchec(supabase, 'gemini'); return res.status(500).json({ error: "Réponse IA illisible, réessaie" }); }

    await signalerSucces(supabase, 'gemini');

    // En mode lot, on garantit toujours un tableau, même si l'IA n'a détecté qu'un seul produit.
    if (modeLot && !Array.isArray(parsed)) parsed = [parsed];

    return res.status(200).json(parsed);
  } catch (e) {
    console.error('Erreur analyser-produit:', e);
    try { await signalerEchec(supabase, 'gemini'); } catch (e2) {}
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

// api/analyser-produit.js
// Reçoit une photo de produit, demande à Gemini (API Google, gratuite) d'en
// déduire un nom, une catégorie et une description. L'admin garde la main
// sur le prix et la quantité, jamais devinés par l'IA.

const { verifierRequeteAdmin } = require('./_lib/adminSession');

const { appelerGemini } = require('./_lib/gemini');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  // Réservé à l'admin connecté : évite qu'un visiteur anonyme épuise le
  // quota gratuit Gemini ou déclenche volontairement le circuit breaker.
  const session = verifierRequeteAdmin(req, process.env.ADMIN_SESSION_SECRET);
  if (!session) {
    return res.status(401).json({ error: 'Accès réservé à l\'administrateur' });
  }

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
      console.error('Configuration : GEMINI_API_KEY manquante');
      return res.status(500).json({ error: "Service non configuré côté serveur" });
    }

    const champsJson = '{"name":"nom court et vendeur du produit, en français","category":"une seule valeur parmi : Téléphonie, Accessoires, Électronique, Réseau, Gaming, Autre","description":"description commerciale de 1 à 2 phrases en français, sans inventer de caractéristiques techniques précises que tu ne peux pas voir sur la photo"}';

    let prompt;
    if (modeLot) {
      prompt = `Voici ${images.length} photos de ${images.length} PRODUITS TECH DIFFÉRENTS (une photo = un produit distinct, dans l'ordre exact où elles sont fournies), destinés à une boutique en ligne au Cameroun (Kapmaket). Analyse chaque photo indépendamment. Réponds UNIQUEMENT avec un tableau JSON valide de ${images.length} objets, un par photo dans le même ordre, sans aucun texte autour, chaque objet exactement sous cette forme : ${champsJson}`;
    } else if (images.length > 1) {
      prompt = `Regarde ces ${images.length} photos du MÊME produit tech (sous différents angles) destiné à une boutique en ligne au Cameroun (Kapmaket). Combine les informations visibles sur toutes les photos. Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour, exactement sous cette forme : ${champsJson}`;
    } else {
      prompt = `Regarde cette photo d'un produit tech destiné à une boutique en ligne au Cameroun (Kapmaket). Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour, exactement sous cette forme : ${champsJson}`;
    }

    const parts = [
      { text: prompt },
      ...images.map(img => ({ inline_data: { mime_type: img.media_type || 'image/jpeg', data: img.data } }))
    ];

    const parse = (texte) => { try { return JSON.parse(String(texte).replace(/```json|```/g, '').trim()); } catch (e) { return null; } };
    const r = await appelerGemini({ parts, usage: 'admin', parse });
    if (!r.ok) {
      console.error(`Analyse produit impossible : statut ${r.statut} — ${r.message || ''}`);
      if (r.statut === 429 && r.quotaJour) return res.status(429).json({ code: 'quota_jour', retry_apres: r.retryApres || 1800, error: "Le quota quotidien de l'IA est atteint. Remplis la fiche à la main, ou réessaie plus tard : il se remet à zéro chaque matin (vers 8 h ou 9 h au Cameroun)." });
      if (r.statut === 429) return res.status(429).json({ code: 'quota', retry_apres: r.retryApres || 60, error: "Limite de requêtes de l'IA atteinte. Réessaie dans environ 1 minute." });
      if ([500, 502, 503, 504].includes(r.statut)) return res.status(503).json({ code: 'surcharge', retry_apres: 10, error: "L'IA est très sollicitée en ce moment (forte demande). Réessaie dans quelques instants." });
      return res.status(500).json({ code: 'erreur', error: "Analyse impossible pour le moment." });
    }
    let parsed = r.valeur;
    // En mode lot, on garantit toujours un tableau, même si l'IA n'a détecté qu'un seul produit.
    if (modeLot && !Array.isArray(parsed)) parsed = [parsed];
    return res.status(200).json(parsed);
  } catch (e) {
    console.error('Erreur analyser-produit:', e);
    return res.status(500).json({ code: 'erreur', error: 'Erreur serveur' });
  }
};

// api/analyser-produit.js
// Reçoit une photo de produit, demande à Gemini (API Google, gratuite) d'en
// déduire un nom, une catégorie et une description. L'admin garde la main
// sur le prix et la quantité, jamais devinés par l'IA.

const { verifierRequeteAdmin } = require('./_lib/adminSession');

// Modèles essayés dans l'ordre : si le premier est surchargé ou introuvable, on passe au suivant.
// Modifiable sans toucher au code : variable GEMINI_MODELES (noms séparés par des virgules).
const MODELES = (process.env.GEMINI_MODELES || 'gemini-3.6-flash,gemini-2.5-flash,gemini-2.5-flash-lite').split(',').map(s => s.trim()).filter(Boolean);
const PAUSE_MS = Number(process.env.GEMINI_PAUSE_MS || 1500);
const TRANSITOIRES = new Set([429, 500, 502, 503, 504]);
const attendre = (ms) => new Promise(ok => setTimeout(ok, ms));

// Appelle l'IA avec 2 essais par modèle (courte pause entre les deux) puis bascule sur le modèle suivant.
// Une surcharge passagère (503, « forte demande ») ne bloque donc plus l'ajout d'un produit.
// Budget total : 45 s, pour rester sous la durée maximale de la fonction (voir vercel.json).
async function analyserAvecRepli(parts, parse) {
    const debut = Date.now();
    let derniere = { statut: 502, message: 'aucune réponse' };
    for (const modele of MODELES) {
        for (let essai = 0; essai < 2; essai++) {
            if (Date.now() - debut > 45000) return { ok: false, ...derniere };
            let resp, data;
            try {
                resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modele}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
                    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } })
                });
                data = await resp.json();
            } catch (e) { derniere = { statut: 504, message: `${modele} : délai dépassé` }; if (essai === 0) await attendre(PAUSE_MS); continue; }
            if (resp.ok) {
                const valeur = parse(data.candidates?.[0]?.content?.parts?.[0]?.text || '');
                if (valeur) return { ok: true, valeur, modele };
                derniere = { statut: 502, message: `${modele} : réponse illisible` };
                break;                                   // réponse inexploitable : modèle suivant
            }
            derniere = { statut: resp.status, message: `${modele} : ${data.error?.message || ''}`.slice(0, 200) };
            if (resp.status === 404 || resp.status === 400) break;                // modèle inconnu ou requête refusée : modèle suivant
            if (!TRANSITOIRES.has(resp.status)) return { ok: false, ...derniere };   // clé refusée, etc. : inutile d'insister
            if (essai === 0) await attendre(PAUSE_MS);
        }
    }
    return { ok: false, ...derniere };
}

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
    const r = await analyserAvecRepli(parts, parse);
    if (!r.ok) {
      console.error(`Analyse produit impossible : statut ${r.statut} — ${r.message || ''}`);
      if (r.statut === 429) return res.status(429).json({ code: 'quota', retry_apres: 60, error: "Limite de requêtes de l'IA atteinte. Réessaie dans environ 1 minute." });
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

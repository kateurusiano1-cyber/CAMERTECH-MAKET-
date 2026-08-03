// api/traduire-produits.js
// Traduit en anglais le nom et la description d'un lot de produits (Gemini,
// gratuit). Utilisé uniquement quand un visiteur bascule le site en EN — les
// données restent en français dans Supabase, la traduction est mise en cache
// côté navigateur pour ne pas répéter l'appel à chaque fois.

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
    let produits = body?.produits;
    if (!produits || !produits.length) return res.status(400).json({ error: 'Aucun produit à traduire' });
    if (produits.length > 30) produits = produits.slice(0, 30); // évite les requêtes trop lourdes

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Clé IA non configurée côté serveur (GEMINI_API_KEY manquante dans Vercel)" });
    }

    // Circuit breaker partagé avec analyser-produit.js (même quota Gemini)
    const circuit = await circuitOuvert(supabase, 'gemini');
    if (circuit.ouvert) {
      return res.status(503).json({ error: `Traduction temporairement indisponible, réessayez dans ${Math.ceil(circuit.retryAfterSeconds / 60)} min.` });
    }

    const prompt = `Traduis en anglais le nom et la description de ces ${produits.length} produits d'une boutique tech (garde les noms de marques et modèles tels quels, ex: "Samsung Galaxy A15" reste "Samsung Galaxy A15"). Réponds UNIQUEMENT avec un tableau JSON valide, sans aucun texte autour, un objet par produit, dans le MÊME ORDRE, exactement sous cette forme : {"id":"reprends l'id fourni tel quel","name":"nom traduit en anglais","description":"description traduite en anglais"}.\n\nProduits à traduire :\n${JSON.stringify(produits)}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
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
    if (!Array.isArray(parsed)) parsed = [parsed];

    await signalerSucces(supabase, 'gemini');

    return res.status(200).json(parsed);
  } catch (e) {
    console.error('Erreur traduire-produits:', e);
    try { await signalerEchec(supabase, 'gemini'); } catch (e2) {}
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

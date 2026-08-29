// api/recherche-photo.js
// Le client prend/choisit une photo d'un produit qu'il cherche ; Gemini
// (déjà utilisée côté admin pour la fiche produit) en déduit une catégorie
// et des mots-clés, que le site utilise ensuite pour filtrer le catalogue
// côté client — aucune clé IA ni logique de recherche n'est exposée au
// navigateur.

const { createClient } = require('@supabase/supabase-js');
const { circuitOuvert, signalerEchec, signalerSucces } = require('./_lib/circuitBreaker');
const { tropDeTentatives, signalerEchecTentative } = require('./_lib/rateLimit');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    try {
        // Fonctionnalité publique (contrairement à l'analyse admin) : on
        // limite par IP pour éviter qu'une seule personne épuise le quota
        // gratuit Gemini pour tout le monde.
        const ip = (req.headers['x-forwarded-for'] || 'ip-inconnue').split(',')[0].trim();
        const cle = `recherche-photo:${ip}`;
        const check = await tropDeTentatives(supabase, cle, 20, 10); // 20 essais / 10 min
        if (check.bloque) {
            return res.status(429).json({ error: `Trop de recherches, réessaie dans ${Math.ceil(check.retryAfterSeconds / 60)} min.` });
        }

        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { image, media_type } = body || {};
        if (!image) return res.status(400).json({ error: 'Image manquante' });

        if (!process.env.GEMINI_API_KEY) {
            return res.status(500).json({ error: "Clé IA non configurée côté serveur" });
        }

        const circuit = await circuitOuvert(supabase, 'gemini');
        if (circuit.ouvert) {
            return res.status(503).json({ error: `Recherche par photo temporairement indisponible, réessaie dans ${Math.ceil(circuit.retryAfterSeconds / 60)} min.` });
        }

        const prompt = `Un client d'une boutique tech au Cameroun (CAMERTECH MARKET) prend cette photo pour chercher un produit similaire dans le catalogue. Identifie de quel type de produit il s'agit. Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour, exactement sous cette forme : {"category":"une seule valeur parmi : Téléphonie, Accessoires, Électronique, Réseau, Gaming, Autre","motscles":["2 à 5 mots-clés courts en français décrivant le produit, ex: écouteurs, bluetooth, chargeur, câble type-c"]}`;

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: media_type || 'image/jpeg', data: image } }] }]
                })
            }
        );

        const data = await response.json();
        if (!response.ok) {
            await signalerEchec(supabase, 'gemini');
            await signalerEchecTentative(supabase, cle, 20, 10);
            return res.status(500).json({ error: data.error?.message || 'Erreur du service de recherche' });
        }

        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const clean = text.replace(/```json|```/g, '').trim();
        let parsed;
        try { parsed = JSON.parse(clean); }
        catch (e) { await signalerEchec(supabase, 'gemini'); return res.status(500).json({ error: 'Résultat illisible, réessaie avec une autre photo' }); }

        await signalerSucces(supabase, 'gemini');
        return res.status(200).json(parsed);
    } catch (e) {
        console.error('Erreur recherche-photo:', e.message);
        try { await signalerEchec(supabase, 'gemini'); } catch (_) {}
        return res.status(500).json({ error: 'Erreur serveur' });
    }
};

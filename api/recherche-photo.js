// api/recherche-photo.js
// Le client prend/choisit une photo d'un produit qu'il cherche ; Gemini
// (déjà utilisée côté admin pour la fiche produit) en déduit une catégorie
// et des mots-clés, que le site utilise ensuite pour filtrer le catalogue
// côté client — aucune clé IA ni logique de recherche n'est exposée au
// navigateur.

const { createClient } = require('@supabase/supabase-js');
const { appelerGemini } = require('./_lib/gemini');
const { circuitOuvert, signalerEchec, signalerSucces } = require('./_lib/circuitBreaker');
const { tropDeTentatives, signalerEchecTentative } = require('./_lib/rateLimit');

module.exports = async (req, res) => {
    // Assistant IA de la bulle d'aide : même fonction, autre adresse, pour rester sous la
    // limite de 12 fonctions de Vercel Hobby. Chargé seulement si besoin.
    if (req.query?.mode === 'assistant') return require('./_lib/assistantHandler')(req, res);

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
        // Catalogue envoyé par le site (id, nom, catégorie) : l'IA choisit directement les produits qui ressemblent.
        const nettoyer = s => String(s == null ? '' : s).replace(/[\r\n\t|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
        const catalogue = Array.isArray(body && body.catalogue)
            ? body.catalogue.slice(0, 200).map(c => ({ id: nettoyer(c && c.id).slice(0, 64), n: nettoyer(c && c.n), c: nettoyer(c && c.c).slice(0, 30) })).filter(c => c.id && c.n)
            : [];
        const CATEGORIES = ['Téléphonie', 'Accessoires', 'Électronique', 'Réseau', 'Gaming', 'Autre'];
        if (!image) return res.status(400).json({ error: 'Image manquante' });

        if (!process.env.GEMINI_API_KEY) {
            return res.status(500).json({ error: "Clé IA non configurée côté serveur" });
        }

        const circuit = await circuitOuvert(supabase, 'gemini');
        if (circuit.ouvert) {
            return res.status(503).json({ error: `Recherche par photo temporairement indisponible, réessaie dans ${Math.ceil(circuit.retryAfterSeconds / 60)} min.` });
        }

        const lignes = catalogue.map(c => `${c.id} | ${c.n}${c.c ? ' | ' + c.c : ''}`).join('\n');
        const prompt = `Un client de Kapmaket (boutique tech au Cameroun) envoie la photo d'un article qu'il cherche. Identifie ce que montre la photo, puis trouve dans le catalogue ci-dessous les produits qui lui ressemblent le plus (même type d'article, même marque ou modèle si visible).
${catalogue.length ? `CATALOGUE (format : id | nom | catégorie) :\n${lignes}\n` : ''}Réponds UNIQUEMENT avec un objet JSON valide, sans aucun texte autour, exactement sous cette forme : {"produit":"nom court de l'article vu sur la photo, en français","category":"une seule valeur parmi : ${CATEGORIES.join(', ')}","motscles":["3 à 6 mots-clés courts au singulier, en français puis en anglais si utile, ex : écouteur, earbuds, bluetooth, oraimo"],"ids":[${catalogue.length ? "ids du catalogue, du plus ressemblant au moins ressemblant, 0 à 8 maximum, recopiés exactement comme dans la liste ; [] si aucun produit du catalogue ne ressemble" : ''}]}`;

        const parse = (texte) => { try { return JSON.parse(String(texte).replace(/```json|```/g, '').trim()); } catch (e) { return null; } };
        const rep = await appelerGemini({ parts: [{ text: prompt }, { inline_data: { mime_type: media_type || 'image/jpeg', data: image } }], usage: 'client', parse });
        if (!rep.ok) {
            console.error(`Recherche photo : IA indisponible (statut ${rep.statut}) — ${rep.message || ''}`);
            // Une surcharge ou un quota épuisé n'est pas une panne : on ne déclenche pas le disjoncteur qui couperait aussi l'assistant.
            if (![429, 503, 504, 502].includes(rep.statut)) await signalerEchec(supabase, 'gemini');
            if ([429, 503, 504].includes(rep.statut)) return res.status(503).json({ error: 'La recherche par photo est très sollicitée en ce moment, réessaie dans quelques instants.' });
            return res.status(500).json({ error: 'Erreur du service de recherche, réessaie.' });
        }
        await signalerSucces(supabase, 'gemini');
        const parsed = rep.valeur;
        // On ne renvoie au navigateur que des valeurs vérifiées (ids du catalogue, catégorie connue, textes courts).
        const brut = parsed && typeof parsed === 'object' ? parsed : {};
        const idsValides = new Set(catalogue.map(c => c.id));
        return res.status(200).json({
            produit: nettoyer(brut.produit),
            category: CATEGORIES.includes(brut.category) ? brut.category : 'Autre',
            motscles: (Array.isArray(brut.motscles) ? brut.motscles : []).map(m => nettoyer(m).slice(0, 40)).filter(Boolean).slice(0, 8),
            ids: (Array.isArray(brut.ids) ? brut.ids : []).map(x => String(x).trim()).filter(x => idsValides.has(x)).slice(0, 8)
        });
    } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
            console.error('Erreur recherche-photo : le service IA a mis trop de temps à répondre');
            try { await signalerEchec(supabase, 'gemini'); } catch (_) {}
            return res.status(504).json({ error: 'La recherche prend trop de temps, réessaie dans un instant.' });
        }
        console.error('Erreur recherche-photo:', e.message);
        try { await signalerEchec(supabase, 'gemini'); } catch (_) {}
        return res.status(500).json({ error: 'Erreur serveur' });
    }
};

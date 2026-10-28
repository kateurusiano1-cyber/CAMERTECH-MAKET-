// Appels à l'IA partagés par toutes les fonctions du site (analyse de produit, recherche par photo, traduction).
//
// Pourquoi : chaque modèle a SON PROPRE quota (requêtes par minute et par jour). Sur l'offre gratuite, un seul modèle précis
// est vite épuisé. On répartit donc la charge sur plusieurs modèles, et on se souvient de ceux dont le quota est épuisé pour
// ne pas leur renvoyer des requêtes inutiles.
//
// Les listes se changent sans toucher au code, dans les variables Vercel (noms de modèles séparés par des virgules) :
//   GEMINI_MODELES_ADMIN   ajout de produits, traduction (précision d'abord)
//   GEMINI_MODELES_CLIENT  recherche par photo des clients (gros quota d'abord, pour garder les modèles précis à l'administration)

const LISTES = {
    admin: () => process.env.GEMINI_MODELES_ADMIN || process.env.GEMINI_MODELES || 'gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite',
    client: () => process.env.GEMINI_MODELES_CLIENT || 'gemini-3.5-flash-lite,gemini-3.8-flash,gemini-3.6-flash'
};
const PAUSE_MS = Number(process.env.GEMINI_PAUSE_MS || 1500);
const TRANSITOIRES = new Set([500, 502, 503, 504]);
const attendre = (ms) => new Promise((ok) => setTimeout(ok, ms));

// modèle -> { jusqua (ms), jour (quota quotidien épuisé) } : modèles mis de côté après une erreur de quota (429)
const pauses = new Map();

function nomsModeles(usage) { return String(LISTES[usage] ? LISTES[usage]() : LISTES.admin()).split(',').map((s) => s.trim()).filter(Boolean); }

// Renvoie { ok: true, valeur, modele } ou { ok: false, statut, message, quotaJour, retryApres }.
//  - surcharge passagère (503…) : 2 essais par modèle, puis modèle suivant ;
//  - quota épuisé (429) : modèle suivant tout de suite, et mis de côté (70 s si c'est la limite par minute, 30 min si c'est la limite du jour) ;
//  - modèle inconnu ou requête refusée (404, 400) : modèle suivant ;
//  - budget total de `budgetMs` pour rester sous la durée maximale de la fonction.
async function appelerGemini({ parts, usage = 'admin', parse, budgetMs = 45000, generation }) {
    const debut = Date.now();
    const tous = nomsModeles(usage);
    const maintenant = Date.now();
    const disponibles = tous.filter((m) => !(pauses.get(m) && pauses.get(m).jusqua > maintenant));
    if (!disponibles.length) {
        const actives = tous.map((m) => pauses.get(m)).filter(Boolean);
        return { ok: false, statut: 429, message: 'tous les modèles sont en pause (quota)', quotaJour: actives.every((p) => p.jour), retryApres: Math.max(5, Math.ceil((Math.min(...actives.map((p) => p.jusqua)) - maintenant) / 1000)) };
    }
    let derniere = { statut: 502, message: 'aucune réponse' };
    let quotas429 = 0, quotasJour = 0;
    for (const modele of disponibles) {
        for (let essai = 0; essai < 2; essai++) {
            if (Date.now() - debut > budgetMs) return { ok: false, ...derniere };
            let resp, data;
            try {
                resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modele}:generateContent?key=${(process.env.GEMINI_API_KEY || '').trim()}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
                    body: JSON.stringify({ contents: [{ parts }], generationConfig: generation || { responseMimeType: 'application/json', temperature: 0.2 } })
                });
                data = await resp.json();
            } catch (e) { derniere = { statut: 504, message: `${modele} : délai dépassé` }; if (essai === 0) await attendre(PAUSE_MS); continue; }
            if (resp.ok) {
                const valeur = parse(data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] ? data.candidates[0].content.parts[0].text || '' : '');
                if (valeur) return { ok: true, valeur, modele };
                derniere = { statut: 502, message: `${modele} : réponse illisible` };
                break;                                                   // réponse inexploitable : modèle suivant
            }
            const brut = JSON.stringify(data && data.error ? data.error : {});
            derniere = { statut: resp.status, message: `${modele} : ${(data && data.error && data.error.message) || ''}`.slice(0, 200) };
            if (resp.status === 429) {
                const jour = /per ?day|daily/i.test(brut);
                pauses.set(modele, { jusqua: Date.now() + (jour ? 30 * 60000 : 70000), jour });
                quotas429++; if (jour) quotasJour++;
                break;                                                   // quota épuisé : inutile de réessayer ce modèle
            }
            if (resp.status === 404 || resp.status === 400) break;
            if (!TRANSITOIRES.has(resp.status)) return { ok: false, ...derniere };   // clé refusée, etc. : inutile d'insister
            if (essai === 0) await attendre(PAUSE_MS);
        }
    }
    const toutesEnQuota = quotas429 === disponibles.length;
    return { ok: false, ...derniere, ...(toutesEnQuota ? { statut: 429, quotaJour: quotasJour === quotas429, retryApres: quotasJour === quotas429 ? 1800 : 60 } : {}) };
}

module.exports = { appelerGemini, _pauses: pauses, nomsModeles };

// api/_lib/demandesStats.js
// Calcule, à partir des données brutes, ce que le vendeur veut voir : « qu'est-ce que les clients veulent ? ».
// Fonction pure (aucun accès réseau) : facile à tester. Appelée par api/admin-action.js (ressource « demandes »).

const { normaliserTerme } = require('./demandes');

const mediane = (nombres) => {
    const t = [...nombres].sort((a, b) => a - b);
    if (!t.length) return null;
    const m = Math.floor(t.length / 2);
    return t.length % 2 ? t[m] : Math.round((t[m - 1] + t[m]) / 2);
};
const variation = (n, avant) => (avant > 0 ? Math.round(((n - avant) / avant) * 100) : null); // null = « nouveau »

// Compte des valeurs sur la période courante et sur la période précédente (de même durée).
function compter(lignes, cle, estCourant, estPrecedent, minimum = 1) {
    const m = new Map();
    lignes.forEach((l) => {
        const k = cle(l);
        if (!k) return;
        const e = m.get(k) || { n: 0, avant: 0 };
        if (estCourant(l)) e.n++; else if (estPrecedent(l)) e.avant++;
        m.set(k, e);
    });
    return [...m.entries()].filter(([, e]) => e.n >= minimum).map(([k, e]) => ({ cle: k, n: e.n, avant: e.avant, variation: variation(e.n, e.avant) })).sort((a, b) => b.n - a.n);
}

function calculerStats({ demandes = [], evenements = [], reservations = [], produits = [], jours = 30, maintenant = Date.now() }) {
    const duree = jours * 24 * 3600 * 1000;
    const debutCourant = maintenant - duree;
    const debutPrecedent = maintenant - 2 * duree;
    const t = (l) => new Date(l.created_at).getTime();
    const courant = (l) => t(l) >= debutCourant;
    const precedent = (l) => t(l) >= debutPrecedent && t(l) < debutCourant;
    const nomProduit = new Map(produits.map((p) => [String(p.id), p.name]));

    // ---- Assistant ----
    const dem = demandes;
    const demCourantes = dem.filter(courant);
    const intentions = compter(dem, (d) => d.intention, courant, precedent).slice(0, 10).map((x) => ({ intention: x.cle, n: x.n, variation: x.variation }));
    const recherchesIA = compter(dem, (d) => normaliserTerme(d.produit_recherche), courant, precedent).slice(0, 12).map((x) => ({ terme: x.cle, n: x.n, variation: x.variation }));
    const sansProduit = compter(dem.filter((d) => d.trouve === false), (d) => normaliserTerme(d.produit_recherche) || normaliserTerme(d.question), courant, precedent).slice(0, 10).map((x) => ({ terme: x.cle, n: x.n }));

    const budgetsParIntention = {};
    demCourantes.forEach((d) => { if (d.budget && d.intention) (budgetsParIntention[d.intention] = budgetsParIntention[d.intention] || []).push(d.budget); });
    const budgets = Object.entries(budgetsParIntention).filter(([, v]) => v.length >= 1)
        .map(([intention, v]) => ({ intention, n: v.length, mediane: mediane(v), min: Math.min(...v), max: Math.max(...v) }))
        .sort((a, b) => b.n - a.n).slice(0, 8);

    const proposes = {};
    demCourantes.forEach((d) => (d.produits_ids || []).forEach((id) => { proposes[id] = (proposes[id] || 0) + 1; }));
    const produitsProposes = Object.entries(proposes).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, n]) => ({ id, nom: nomProduit.get(String(id)) || '(produit supprimé)', n }));

    // ---- Comportement sur le site (suivi déjà en place) ----
    const evCourants = evenements.filter(courant), evPrecedents = evenements.filter(precedent);
    const barre = compter(evenements.filter((e) => e.type === 'recherche'), (e) => normaliserTerme(e.cible), courant, precedent, 1).slice(0, 12).map((x) => ({ terme: x.cle, n: x.n, variation: x.variation }));
    const categories = compter(evenements.filter((e) => e.type === 'filtre_categorie'), (e) => String(e.cible || '').trim(), courant, precedent).slice(0, 8).map((x) => ({ categorie: x.cle, n: x.n, variation: x.variation }));

    const parProduit = new Map();
    const noterProduit = (id, nomMeta) => parProduit.get(id) || (parProduit.set(id, { id, nom: nomProduit.get(String(id)) || nomMeta || '(produit supprimé)', vues: 0, paniers: 0, vendus: 0, vuesAvant: 0 }), parProduit.get(id));
    evCourants.forEach((e) => {
        if (!e.cible) return;
        if (e.type === 'produit_vu') noterProduit(e.cible, e.meta && e.meta.nom).vues++;
        if (e.type === 'panier_ajout') noterProduit(e.cible, e.meta && e.meta.nom).paniers += Math.max(1, Number(e.meta && e.meta.qty) || 1);
    });
    evPrecedents.forEach((e) => { if (e.type === 'produit_vu' && e.cible) noterProduit(e.cible, e.meta && e.meta.nom).vuesAvant++; });

    let commandesPayees = 0;
    reservations.filter((r) => ['valide', 'en attente', 'livre'].includes(r.statut) && t(r) >= debutCourant).forEach((r) => {
        commandesPayees++;
        (Array.isArray(r.items) ? r.items : []).forEach((it) => { if (it && it.id) noterProduit(it.id, it.name).vendus += Math.max(1, Number(it.qty) || 1); });
    });
    const produitsSite = [...parProduit.values()].map((p) => ({ ...p, variation: variation(p.vues, p.vuesAvant) }))
        .sort((a, b) => (b.paniers * 3 + b.vues) - (a.paniers * 3 + a.vues)).slice(0, 15);

    // ---- Moments de la journée et tendance ----
    const heures = new Array(24).fill(0);
    demCourantes.forEach((d) => { heures[(new Date(t(d)).getUTCHours() + 1) % 24]++; }); // heure de Douala (UTC+1)
    const parJour = {};
    dem.filter((d) => t(d) >= maintenant - 14 * 24 * 3600 * 1000).forEach((d) => { const j = new Date(t(d)).toISOString().slice(0, 10); parJour[j] = (parJour[j] || 0) + 1; });
    const tendance = Object.entries(parJour).sort().map(([jour, n]) => ({ jour, n }));

    const sessions = new Set(demCourantes.map((d) => d.session).filter(Boolean));
    const nbHumain = demCourantes.filter((d) => d.humain).length;

    return {
        jours,
        totaux: {
            questions: demCourantes.length, questions_avant: dem.filter(precedent).length, personnes: sessions.size,
            recherches_barre: evCourants.filter((e) => e.type === 'recherche').length,
            vues_produits: evCourants.filter((e) => e.type === 'produit_vu').length,
            ajouts_panier: evCourants.filter((e) => e.type === 'panier_ajout').length,
            commandes_payees: commandesPayees,
            part_whatsapp: demCourantes.length ? Math.round((nbHumain / demCourantes.length) * 100) : 0
        },
        assistant: { intentions, recherches: recherchesIA, sans_produit: sansProduit, budgets, produits_proposes: produitsProposes },
        site: { recherches_barre: barre, categories, produits: produitsSite },
        heures, tendance,
        questions_recentes: [...demCourantes].sort((a, b) => t(b) - t(a)).slice(0, 25).map((d) => ({ date: d.created_at, question: d.question, intention: d.intention, trouve: d.trouve }))
    };
}

module.exports = { calculerStats, mediane, variation };

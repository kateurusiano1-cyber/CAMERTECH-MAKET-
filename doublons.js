// Détection des doublons de produits. Fichier partagé : chargé par le navigateur (panneau admin) et par le serveur
// (api/admin-action.js), pour que l'avertissement et le contrôle de sécurité appliquent exactement les mêmes règles.
(function (racine) {
    const MOTS_VIDES = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'un', 'une', 'et', 'pour', 'avec', 'sans', 'en', 'au', 'aux', 'the', 'for', 'with', 'and', 'of']);
    const sansAccents = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // « Câble USB-C 65W » → [cable, usb, c, 65, w] ; « 30 000 mAh » et « 30000 mAh » donnent les mêmes jetons.
    function jetons(nom) {
        const n = sansAccents(nom).replace(/(\d)[\s.,](?=\d{3}(?!\d))/g, '$1');
        return n.split(/[^a-z0-9]+/).flatMap((t) => t.match(/\d+|[a-z]+/g) || []).filter((t) => !MOTS_VIDES.has(t));
    }

    function distance(a, b) {
        const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
        for (let i = 1; i <= a.length; i++) {
            let diag = prev[0]; prev[0] = i;
            for (let j = 1; j <= b.length; j++) {
                const tmp = prev[j];
                prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
                diag = tmp;
            }
        }
        return prev[b.length];
    }

    // null = produits différents ; sinon { niveau: 'identique' | 'tres_proche', score }
    function comparer(nomA, nomB) {
        const A = jetons(nomA), B = jetons(nomB);
        if (!A.length || !B.length) return null;
        if (A.join('') === B.join('')) return { niveau: 'identique', score: 1 };            // mêmes mots, espaces / tirets / accents / casse près
        const sa = new Set(A), sb = new Set(B);
        const nombres = (s) => [...s].filter((t) => /^\d+$/.test(t)).sort().join(',');
        if (nombres(sa) !== nombres(sb)) return null;                                        // autre numéro de modèle, capacité ou taille = autre produit
        if ([...sa].sort().join('|') === [...sb].sort().join('|')) return { niveau: 'identique', score: 1 };   // mêmes mots dans un autre ordre
        const inter = [...sa].filter((t) => sb.has(t)).length;
        const jacc = inter / new Set([...sa, ...sb]).size;
        const cont = inter / Math.min(sa.size, sb.size);
        if ((jacc >= 0.75 && inter >= 2) || (cont >= 0.85 && inter >= 3)) return { niveau: 'tres_proche', score: Math.max(jacc, cont) * 0.95 };
        const ca = A.join(''), cb = B.join('');
        if (Math.min(ca.length, cb.length) >= 6 && distance(ca, cb) / Math.max(ca.length, cb.length) <= 0.1) return { niveau: 'tres_proche', score: 0.9 };   // faute de frappe
        return null;
    }

    // Produits déjà présents qui ressemblent à `nom`, les plus proches d'abord.
    function trouverDoublons(nom, liste, options) {
        const { ignorerId = null, max = 5 } = options || {};
        const trouves = [];
        (liste || []).forEach((p) => {
            if (!p || (ignorerId != null && p.id === ignorerId)) return;
            const r = comparer(nom, p.name);
            if (r) trouves.push({ produit: p, niveau: r.niveau, score: r.score });
        });
        trouves.sort((x, y) => (x.niveau === y.niveau ? y.score - x.score : x.niveau === 'identique' ? -1 : 1));
        return trouves.slice(0, max);
    }

    const api = { trouverDoublons, comparer, jetons };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else racine.CMKT_DOUBLONS = api;
})(typeof window !== 'undefined' ? window : this);

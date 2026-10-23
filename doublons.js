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

    // ---- Photos : l'empreinte visuelle (dHash 16×16 = 64 caractères hexadécimaux) est calculée par le navigateur ;
    // ici on ne fait que les comparer. 0 = images identiques, ~128 = images sans rapport.
    function distanceEmpreintes(h1, h2) {
        if (!h1 || !h2 || h1.length !== h2.length) return 256;
        let n = 0;
        for (let i = 0; i < h1.length; i++) { let x = parseInt(h1[i], 16) ^ parseInt(h2[i], 16); while (x) { n += x & 1; x >>= 1; } }
        return n;
    }
    const SEUIL_PHOTO_IDENTIQUE = 30, SEUIL_PHOTO_PROCHE = 42;   // calés sur des mesures réelles : même photo recompressée 18 à 27, photos sans rapport 67 à 87

    // Vrai si les deux noms portent chacun des numéros, et pas les mêmes (FreePods 4 / 5, 65W / 20W) : probablement deux modèles
    // distincts. Si l'un des noms n'a aucun numéro, on ne peut rien conclure.
    function numerosDifferents(nomA, nomB) {
        const nombres = (nom) => [...new Set(jetons(nom).filter((t) => /^\d+$/.test(t)))].sort().join(',');
        const a = nombres(nomA), b = nombres(nomB);
        return a !== '' && b !== '' && a !== b;
    }

    // Scan du catalogue entier. `empreintes` : { urlDeLaPhoto: empreinte }. Renvoie des groupes de produits qui semblent n'en faire qu'un :
    // [{ ids, score, confiance, raisons }]. Critères : nom, photo (même fichier ou visuellement identique), description, prix.
    function scannerCatalogue(produits, empreintes, options) {
        const { seuil = 70 } = options || {};
        const liste = (produits || []).filter((p) => p && p.id != null);
        const norm = (s) => sansAccents(s).replace(/[^a-z0-9]+/g, ' ').trim();
        const paires = [];
        for (let i = 0; i < liste.length; i++) {
            for (let j = i + 1; j < liste.length; j++) {
                const a = liste[i], b = liste[j];
                let score = 0; const raisons = [];
                const n = comparer(a.name, b.name);
                if (n) { score += n.niveau === 'identique' ? 100 : 70; raisons.push(n.niveau === 'identique' ? 'même nom' : 'nom très proche'); }
                const ua = String(a.image_url || '').trim(), ub = String(b.image_url || '').trim();
                if (ua && ua === ub) { score += 100; raisons.push('même photo (même fichier)'); }
                else if (ua && ub && empreintes && empreintes[ua] && empreintes[ub]) {
                    const dist = distanceEmpreintes(empreintes[ua], empreintes[ub]);
                    // Deux modèles voisins ont souvent des emballages semblables : si les numéros diffèrent, la photo seule ne suffit pas.
                    const poids = (!n && numerosDifferents(a.name, b.name)) ? 0.55 : 1;
                    if (dist <= SEUIL_PHOTO_IDENTIQUE) { score += Math.round(90 * poids); raisons.push('photo quasi identique'); }
                    else if (dist <= SEUIL_PHOTO_PROCHE) { score += Math.round(50 * poids); raisons.push('photo ressemblante'); }
                }
                const da = norm(a.description), db = norm(b.description);
                if (da.length >= 25 && da === db) { score += 60; raisons.push('même description'); }
                if (Number(a.purchase_price) > 0 && Number(a.purchase_price) === Number(b.purchase_price) && Number(a.resale_price) === Number(b.resale_price)) { score += 20; raisons.push('mêmes prix'); }
                if (a.category && a.category === b.category) score += 5;
                if (score >= seuil) paires.push({ a: a.id, b: b.id, score, raisons });
            }
        }
        // Regroupement : si A ressemble à B et B à C, les trois forment un seul groupe.
        const parent = new Map();
        const racineDe = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
        paires.forEach((p) => { [p.a, p.b].forEach((x) => { if (!parent.has(x)) parent.set(x, x); }); parent.set(racineDe(p.a), racineDe(p.b)); });
        const groupes = new Map();
        paires.forEach((p) => {
            const r = racineDe(p.a);
            if (!groupes.has(r)) groupes.set(r, { ids: new Set(), score: 0, raisons: new Set() });
            const g = groupes.get(r); g.ids.add(p.a); g.ids.add(p.b); g.score = Math.max(g.score, p.score); p.raisons.forEach((x) => g.raisons.add(x));
        });
        return [...groupes.values()].map((g) => ({
            ids: [...g.ids], score: g.score, raisons: [...g.raisons],
            confiance: g.score >= 100 ? 'quasi certain' : g.score >= 85 ? 'probable' : 'possible'
        })).sort((x, y) => y.score - x.score);
    }

    const api = { trouverDoublons, comparer, jetons, distanceEmpreintes, numerosDifferents, scannerCatalogue, SEUIL_PHOTO_IDENTIQUE, SEUIL_PHOTO_PROCHE };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else racine.CMKT_DOUBLONS = api;
})(typeof window !== 'undefined' ? window : this);

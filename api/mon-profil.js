// api/mon-profil.js
// Remplace l'ancienne lecture directe et publique de la table `utilisateurs`
// (policy pub_utilisateurs, supprimée — elle exposait TOUS les clients à
// n'importe qui). Ici, le jeton Firebase du client est vérifié côté serveur
// et seule SA PROPRE ligne est renvoyée, avec uniquement les colonnes utiles
// (jamais mot_de_passe).
//
// Gère aussi, pour le client connecté UNIQUEMENT (jeton Firebase vérifié) :
//   GET  ?ressource=panier           -> son panier synchronisé
//   GET  ?ressource=favoris          -> la liste de ses favoris
//   POST { action:'panier_sauver' }  -> enregistre son panier
//   POST { action:'favori_ajouter' | 'favori_retirer', product_id }
// Les tables `paniers` et `favoris` ne sont donc plus accessibles avec la clé
// publique (leurs anciennes règles anonymes ouvertes sont supprimées).
// Tout est regroupé ici pour ne pas dépasser la limite de 12 fonctions Vercel.

const { createClient } = require('@supabase/supabase-js');
const { verifierRequeteUtilisateur } = require('./_lib/verifierFirebaseToken');
const crypto = require('crypto');

const COLONNES_PUBLIQUES = 'id,nom,email,telephone,points,created_at,firebase_uid,politique_acceptee_le';

// Taux de conversion fidélité → bon de réduction : 100 points = 500 FCFA
// (soit 1 point = 5 FCFA). Conversion par palier de 100 points uniquement,
// pour éviter des bons à des montants bizarres (ex: 37 FCFA).
const POINTS_PAR_PALIER = 100;
const FCFA_PAR_PALIER = 500;

// ---- Nettoyage du panier reçu du navigateur (jamais de confiance aveugle) ----
// Les prix réels sont de toute façon recalculés côté serveur au paiement
// (api/preparer-paiement.js) : ici on borne seulement la taille et le format.
const MAX_ARTICLES_PANIER = 60;
const texteCourt = (v, max) => (typeof v === 'string' && v.length ? v.slice(0, max) : null);
const entier = (v, min, max, defaut) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : defaut;
};

function nettoyerPanier(brut) {
    if (!Array.isArray(brut)) return null;
    const propre = [];
    for (const a of brut.slice(0, MAX_ARTICLES_PANIER)) {
        if (!a || typeof a !== 'object') continue;
        const id = (typeof a.id === 'string' || typeof a.id === 'number') ? a.id : null;
        if (id === null || String(id).length > 64) continue;
        const prix = Number(a.prix);
        propre.push({
            id,
            name: texteCourt(a.name, 200) || 'Produit',
            prix: Number.isFinite(prix) && prix >= 0 && prix <= 100000000 ? prix : 0,
            qty: entier(a.qty, 1, 99, 1),
            image_url: texteCourt(a.image_url, 500),
            ...(a.combo_id ? { combo_id: texteCourt(String(a.combo_id), 64), combo_nom: texteCourt(a.combo_nom, 200) } : {})
        });
    }
    return propre;
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const uid = await verifierRequeteUtilisateur(req);
    if (!uid) return res.status(401).json({ error: 'Session invalide, reconnecte-toi' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: user, error: errUser } = await supabase.from('utilisateurs').select('id, points').eq('firebase_uid', uid).single();
    if (errUser || !user) return res.status(404).json({ error: 'Profil introuvable' });

    if (req.method === 'GET') {
        const ressource = req.query && req.query.ressource;
        if (ressource === 'panier') {
            const { data, error } = await supabase.from('paniers')
                .select('items, zone, frais_livraison, updated_at')
                .eq('utilisateur_id', user.id).maybeSingle();
            if (error) { console.error('Erreur lecture panier:', error.message); return res.status(500).json({ error: 'Erreur serveur' }); }
            return res.status(200).json({ panier: data || null });
        }
        if (ressource === 'favoris') {
            const { data, error } = await supabase.from('favoris').select('product_id').eq('utilisateur_id', user.id);
            if (error) { console.error('Erreur lecture favoris:', error.message); return res.status(500).json({ error: 'Erreur serveur' }); }
            return res.status(200).json({ favoris: (data || []).map(f => f.product_id) });
        }
        const { data, error } = await supabase.from('utilisateurs').select(COLONNES_PUBLIQUES).eq('firebase_uid', uid).single();
        if (error || !data) return res.status(404).json({ error: 'Profil introuvable' });
        return res.status(200).json({ profil: data });
    }

    if (req.method === 'POST') {
        let body = {};
        try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch (e) { return res.status(400).json({ error: 'JSON invalide' }); }

        if (body.action === 'convertir_points') {
            // Jamais confiance au nombre de points envoyé par le navigateur —
            // on relit le solde réel en base avant toute conversion.
            const pointsDemandes = parseInt(body.points, 10);
            if (!pointsDemandes || pointsDemandes <= 0 || pointsDemandes % POINTS_PAR_PALIER !== 0) {
                return res.status(400).json({ error: `Le nombre de points doit être un multiple de ${POINTS_PAR_PALIER}.` });
            }
            if (pointsDemandes > (user.points || 0)) {
                return res.status(400).json({ error: 'Solde de points insuffisant.' });
            }

            const montantBon = (pointsDemandes / POINTS_PAR_PALIER) * FCFA_PAR_PALIER;
            const code = 'FID-' + crypto.randomBytes(4).toString('hex').toUpperCase();
            const dateExpiration = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(); // valable 90 jours

            const { error: errInsert } = await supabase.from('codes_promo').insert([{
                code, type: 'montant', valeur: montantBon, actif: true,
                usage_max: 1, usage_actuel: 0,
                utilisateur_id: user.id, date_expiration: dateExpiration
            }]);
            if (errInsert) { console.error('Erreur création bon fidélité:', errInsert.message); return res.status(500).json({ error: 'Erreur lors de la création du bon' }); }

            const { error: errMaj } = await supabase.from('utilisateurs').update({ points: user.points - pointsDemandes }).eq('id', user.id);
            if (errMaj) console.error('Erreur déduction points:', errMaj.message);

            return res.status(200).json({ code, montant: montantBon, points_restants: user.points - pointsDemandes, expire_le: dateExpiration });
        }

        if (body.action === 'panier_sauver') {
            const items = nettoyerPanier(body.items);
            if (!items) return res.status(400).json({ error: 'Panier invalide' });
            const maintenant = new Date().toISOString();
            const { data: ligne, error } = await supabase.from('paniers').upsert({
                utilisateur_id: user.id,
                items,
                zone: texteCourt(body.zone, 100),
                frais_livraison: entier(body.frais_livraison, 0, 1000000, 0),
                updated_at: maintenant
            }, { onConflict: 'utilisateur_id' }).select('updated_at').single();
            if (error) { console.error('Erreur sauvegarde panier:', error.message); return res.status(500).json({ error: 'Erreur serveur' }); }
            // On renvoie la valeur telle que stockée (même format qu'à la lecture) :
            // le navigateur s'en sert pour reconnaître sa propre sauvegarde.
            return res.status(200).json({ ok: true, updated_at: ligne ? ligne.updated_at : maintenant });
        }

        if (body.action === 'favori_ajouter' || body.action === 'favori_retirer') {
            const productId = body.product_id;
            if ((typeof productId !== 'string' && typeof productId !== 'number') || String(productId).length > 64) {
                return res.status(400).json({ error: 'Produit invalide' });
            }
            // Dans tous les cas on retire d'abord l'éventuelle ligne existante :
            // l'opération reste valable même sans contrainte d'unicité en base.
            const { error: errDel } = await supabase.from('favoris').delete().eq('utilisateur_id', user.id).eq('product_id', productId);
            if (errDel) { console.error('Erreur favori (retrait):', errDel.message); return res.status(500).json({ error: 'Erreur serveur' }); }
            if (body.action === 'favori_ajouter') {
                const { data: produit } = await supabase.from('products').select('id').eq('id', productId).maybeSingle();
                if (!produit) return res.status(404).json({ error: 'Produit introuvable' });
                const { error: errIns } = await supabase.from('favoris').insert([{ utilisateur_id: user.id, product_id: productId }]);
                if (errIns) { console.error('Erreur favori (ajout):', errIns.message); return res.status(500).json({ error: 'Erreur serveur' }); }
            }
            return res.status(200).json({ ok: true });
        }

        return res.status(400).json({ error: 'Action inconnue' });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
};

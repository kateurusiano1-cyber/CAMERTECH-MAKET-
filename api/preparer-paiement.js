// api/preparer-paiement.js
// SEUL point d'entrée pour créer/payer une commande. Avant ce correctif, le
// navigateur calculait lui-même le total (à partir du panier local) et
// l'écrivait DIRECTEMENT dans Supabase avec la clé publique — un total
// truqué dans la console du navigateur (ex: panier[0].prix = 1) suffisait à
// payer n'importe quel produit pour presque rien, malgré la "revérification"
// plus bas, puisqu'elle revérifiait une valeur déjà écrite par le client.
//
// Désormais : le navigateur n'envoie QUE des identifiants de produits + des
// quantités. Le serveur relit les VRAIS prix dans la table `products`,
// recalcule lui-même le total, génère lui-même un code de commande
// (aléatoire cryptographique, pas Math.random()+timestamp), et c'est lui qui
// écrit dans Supabase — avec la clé service role, jamais le navigateur.
//
// Body attendu (JSON), selon le cas :
//   - Nouvelle commande à payer tout de suite (mode widget) :
//       { items: [{id, qty}], zone_livraison, frais_livraison, note }
//   - Réservation sans paiement immédiat :
//       { items: [{id, qty}], reservation: true }
//   - Payer une commande déjà existante ("Payer maintenant" / Mes Commandes) :
//       { reference: "CMT-..." }
// Accompagné soit d'un en-tête Authorization: Bearer <jeton Firebase> (client
// avec compte), soit d'un champ { invite: { nom, telephone } } dans le body
// (achat sans compte — pas de jeton). Sans l'un ou l'autre, la requête est
// refusée. Un achat "invité" n'a pas d'historique de commandes ni de points
// de fidélité — uniquement le code généré, à conserver pour le suivi.

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { circuitOuvert, signalerEchec, signalerSucces } = require('./_lib/circuitBreaker');
const { verifierRequeteUtilisateur } = require('./_lib/verifierFirebaseToken');
const { tropDeTentatives, signalerEchecTentative } = require('./_lib/rateLimit');

// Même logique de prix que côté client (getPrix dans script.js), mais ici
// c'est la SEULE version qui compte — celle du navigateur ne sert plus qu'à
// l'affichage.
const prixReel = p => (p.promo_active || p.flash_active) && p.promo_prix ? p.promo_prix : p.resale_price;

// Code aléatoire cryptographique — remplace 'CMT-'+Math.random()...+Date.now()
// (seulement ~46 656 combinaisons réelles, et un suffixe d'horodatage
// prévisible). 5 octets hex = 10 caractères, ~1.1 * 10^12 combinaisons.
function genererCodeCommande() {
    return 'CMT-' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

// Valide un code promo par rapport aux VRAIES règles en base (jamais un
// pourcentage envoyé par le navigateur). Ne modifie rien — l'incrémentation
// du compteur d'usage se fait séparément, uniquement quand la commande est
// réellement créée (jamais au moment d'un simple aperçu).
async function validerCodePromo(supabase, codeSaisi, sousTotal) {
    if (!codeSaisi) return { valide: false, reduction: 0 };
    const code = String(codeSaisi).trim().toUpperCase();
    if (!code) return { valide: false, reduction: 0 };

    const { data: promo } = await supabase.from('codes_promo').select('*').eq('code', code).single();
    if (!promo) return { valide: false, reduction: 0, message: 'Code promo introuvable.' };
    if (!promo.actif) return { valide: false, reduction: 0, message: "Ce code promo n'est plus actif." };
    if (promo.date_expiration && new Date(promo.date_expiration) < new Date()) {
        return { valide: false, reduction: 0, message: 'Ce code promo a expiré.' };
    }
    if (promo.usage_max != null && promo.usage_actuel >= promo.usage_max) {
        return { valide: false, reduction: 0, message: "Ce code promo a atteint sa limite d'utilisation." };
    }
    if (promo.montant_min && sousTotal < promo.montant_min) {
        return { valide: false, reduction: 0, message: `Ce code nécessite un minimum de ${Math.round(promo.montant_min)} FCFA d'achat.` };
    }

    let reduction = promo.type === 'pourcentage' ? Math.round(sousTotal * (promo.valeur / 100)) : Math.round(promo.valeur);
    reduction = Math.max(0, Math.min(reduction, sousTotal)); // jamais négatif, jamais plus que le sous-total

    return { valide: true, reduction, id: promo.id, code: promo.code, message: `Code "${promo.code}" appliqué : -${reduction} FCFA` };
}

// Valide un groupe d'articles envoyé comme "Flash Combo" (1 produit
// principal + N accessoires au choix). Ne fait JAMAIS confiance au prix
// envoyé par le navigateur — relit l'offre réelle en base, vérifie que la
// composition (principal + accessoires distincts, dans le pool autorisé,
// offre active et dans les dates) correspond exactement, puis renvoie le
// vrai prix forfaitaire. Si quoi que ce soit ne correspond pas, renvoie
// valide:false — l'appelant retombe alors sur le prix normal de chaque
// article, jamais sur une réduction non vérifiée.
async function validerOffreGroupee(supabase, offreId, itemsDuGroupe) {
    const { data: offre } = await supabase.from('offres_groupees').select('*').eq('id', offreId).single();
    if (!offre || !offre.actif) return { valide: false };
    const maintenant = new Date();
    if (offre.date_debut && new Date(offre.date_debut) > maintenant) return { valide: false };
    if (offre.date_fin && new Date(offre.date_fin) < maintenant) return { valide: false };

    const nbAttendu = 1 + offre.nb_choix_requis;
    if (itemsDuGroupe.length !== nbAttendu) return { valide: false };
    if (itemsDuGroupe.some(it => (parseInt(it.qty, 10) || 1) !== 1)) return { valide: false }; // 1 kit à la fois

    const principal = itemsDuGroupe.find(it => it.id === offre.produit_principal_id);
    if (!principal) return { valide: false };
    const accessoires = itemsDuGroupe.filter(it => it.id !== offre.produit_principal_id);
    const idsAccessoires = accessoires.map(a => a.id);
    if (new Set(idsAccessoires).size !== idsAccessoires.length) return { valide: false }; // pas de doublon

    const { data: pool } = await supabase.from('offres_groupees_choix').select('produit_id').eq('offre_id', offreId);
    const poolIds = new Set((pool || []).map(p => p.produit_id));
    if (!idsAccessoires.every(id => poolIds.has(id))) return { valide: false };

    return { valide: true, prix: offre.prix_ensemble, nom: offre.nom };
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    try {
        const uid = await verifierRequeteUtilisateur(req);
        const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
        const { reference, items, zone_livraison, frais_livraison, note, reservation, code_promo, preview, invite, visiteur_session_id } = body;

        let user; // forme commune { id, nom, telephone, email } — id est null pour un invité
        if (uid) {
            const { data: u, error: errUser } = await supabase
                .from('utilisateurs').select('id,nom,telephone,email').eq('firebase_uid', uid).single();
            if (errUser || !u) return res.status(404).json({ error: 'Profil introuvable' });
            user = u;
        } else if (invite && typeof invite === 'object') {
            const nom = String(invite.nom || '').trim().slice(0, 80);
            const telephone = String(invite.telephone || '').trim().slice(0, 20);
            if (!nom) return res.status(400).json({ error: 'Nom requis' });
            if (telephone.length < 8) return res.status(400).json({ error: 'Numéro de téléphone invalide' });
            user = { id: null, nom, telephone, email: null };
        } else if (preview) {
            // Un simple aperçu (avant même de renseigner nom/téléphone) ne
            // crée rien en base — pas besoin d'identité pour ça.
            user = { id: null, nom: null, telephone: null, email: null };
        } else {
            return res.status(401).json({ error: 'Connecte-toi ou renseigne tes informations pour continuer' });
        }

        // Limite par compte (jeton Firebase) si connecté, sinon par IP pour
        // un invité — empêche un script de deviner des codes de commande en
        // boucle, ou de spammer la création de commandes.
        const ip = (req.headers['x-forwarded-for'] || 'ip-inconnue').split(',')[0].trim();
        const cle = 'preparer-paiement:' + (uid || ('invite:' + ip));
        const check = await tropDeTentatives(supabase, cle, 20, 10); // 20 essais / 10 min
        if (check.bloque) return res.status(429).json({ error: `Trop de tentatives. Réessaie dans ${Math.ceil(check.retryAfterSeconds / 60)} min.` });
        await signalerEchecTentative(supabase, cle, 20, 10);

        let resa;

        if (reference) {
            // --- Payer une commande déjà créée (ex: "Payer maintenant" depuis Mes Commandes) ---
            const { data, error } = await supabase
                .from('reservations').select('code, total, statut, utilisateur_id')
                .eq('code', reference).single();
            if (error || !data) return res.status(404).json({ error: 'Commande introuvable' });
            // Empêche de payer/consulter la commande de quelqu'un d'autre en
            // devinant simplement son code (aucune vérification n'existait avant).
            // Pour un invité (user.id === null), ça ne passe que si la
            // commande a elle-même été créée sans compte (utilisateur_id null).
            if (data.utilisateur_id !== user.id) return res.status(403).json({ error: "Cette commande ne t'appartient pas" });
            resa = data;
        } else {
            // --- Nouvelle commande : tout est recalculé ici, jamais depuis le navigateur ---
            if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Panier vide' });
            if (items.length > 50) return res.status(400).json({ error: 'Panier trop volumineux' });

            const ids = [...new Set(items.map(it => it && it.id))].filter(Boolean);
            const { data: produits, error: errProd } = await supabase
                .from('products').select('id,name,resale_price,promo_active,promo_prix,flash_active').in('id', ids);
            if (errProd) return res.status(500).json({ error: 'Impossible de vérifier les produits' });

            let sousTotal = 0;
            let montantCombos = 0; // déjà à prix forfaitaire réduit — jamais re-remisé par un code promo
            const itemsValides = [];

            // Sépare les articles qui font partie d'un "Flash Combo" (tag
            // combo_id envoyé par le navigateur, juste une suggestion — la
            // composition et le prix réels sont revérifiés ci-dessous) des
            // articles normaux.
            const groupesCombo = {};
            const itemsNormaux = [];
            for (const it of items) {
                if (it && it.combo_id) {
                    (groupesCombo[it.combo_id] = groupesCombo[it.combo_id] || []).push(it);
                } else {
                    itemsNormaux.push(it);
                }
            }

            const idsDansCombosInvalides = []; // retombent en articles normaux si le combo ne colle pas
            for (const [comboId, itemsDuGroupe] of Object.entries(groupesCombo)) {
                const resultat = await validerOffreGroupee(supabase, comboId, itemsDuGroupe);
                if (resultat.valide) {
                    for (const it of itemsDuGroupe) {
                        const p = produits && produits.find(x => x.id === it.id);
                        if (!p) return res.status(400).json({ error: `Produit introuvable ou retiré du catalogue (id: ${it.id})` });
                        itemsValides.push({ id: p.id, name: p.name, qty: 1, prix: 0, combo: resultat.nom });
                    }
                    // Le prix du kit est affiché en une seule fois, sur la
                    // première ligne du groupe (plus lisible sur la facture
                    // qu'un prix éclaté arbitrairement entre les 3 articles).
                    itemsValides[itemsValides.length - itemsDuGroupe.length].prix = resultat.prix;
                    sousTotal += resultat.prix;
                    montantCombos += resultat.prix;
                } else {
                    idsDansCombosInvalides.push(...itemsDuGroupe);
                }
            }
            const aTraiterNormalement = [...itemsNormaux, ...idsDansCombosInvalides];

            for (const it of aTraiterNormalement) {
                const p = produits && produits.find(x => x.id === it.id);
                if (!p) return res.status(400).json({ error: `Produit introuvable ou retiré du catalogue (id: ${it && it.id})` });
                const qty = Math.max(1, Math.min(99, parseInt(it.qty, 10) || 1));
                const prix = prixReel(p);
                sousTotal += prix * qty;
                itemsValides.push({ id: p.id, name: p.name, qty, prix });
            }

            const estReservation = !!reservation;
            const frais = estReservation ? 0 : Math.max(0, parseInt(frais_livraison, 10) || 0);

            // La réduction s'applique sur le sous-total des articles hors
            // Flash Combo, jamais sur les frais de livraison ni sur un kit
            // déjà à prix forfaitaire réduit (non cumulable).
            const sousTotalRemisable = Math.max(0, sousTotal - montantCombos);
            const promoResult = (sousTotalRemisable === 0 && montantCombos > 0 && code_promo)
                ? { valide: false, reduction: 0, message: "Ce code ne s'applique pas : ton panier ne contient qu'un Flash Combo, déjà à prix réduit." }
                : await validerCodePromo(supabase, code_promo, sousTotalRemisable);
            const total = Math.max(0, sousTotal - promoResult.reduction) + frais;

            if (preview) {
                // Aperçu uniquement : rien n'est créé ni compté comme utilisé,
                // ça sert juste à afficher la réduction avant de payer.
                return res.status(200).json({
                    success: true,
                    sous_total: sousTotal,
                    reduction: promoResult.reduction,
                    total,
                    code_valide: promoResult.valide,
                    message: promoResult.message || null
                });
            }

            const code = genererCodeCommande();
            const { data: nouvelle, error: errInsert } = await supabase.from('reservations').insert([{
                utilisateur_id: user.id, nom_client: user.nom, telephone: user.telephone,
                code, items: itemsValides, total,
                statut: estReservation ? 'reservee' : 'paiement_en_cours',
                zone_livraison: zone_livraison || null,
                frais_livraison: frais,
                note: note || null,
                code_promo: promoResult.valide ? promoResult.code : null,
                visiteur_session_id: (typeof visiteur_session_id === 'string' && visiteur_session_id.length <= 100) ? visiteur_session_id : null
            }]).select('code, total, statut, utilisateur_id').single();

            if (errInsert || !nouvelle) {
                console.error('Erreur création réservation:', errInsert && errInsert.message);
                return res.status(500).json({ error: 'Impossible de créer la commande' });
            }
            resa = nouvelle;

            // Le compteur d'usage n'est incrémenté que si la commande est
            // réellement créée (jamais lors d'un aperçu) — via une fonction
            // SQL atomique pour rester correct même avec des paiements
            // simultanés sur le même code.
            if (promoResult.valide && promoResult.id) {
                try { await supabase.rpc('increment_promo_usage', { promo_id: promoResult.id }); }
                catch (e) { console.error('Erreur incrémentation code promo:', e.message); }
            }

            if (estReservation) {
                // Réservation sans paiement : pas besoin du widget iKeePay.
                return res.status(200).json({ success: true, code: resa.code, total: resa.total });
            }
        }

        if (resa.statut === 'valide') return res.status(400).json({ error: 'Cette commande est déjà payée' });
        if (!resa.total || resa.total < 100) return res.status(400).json({ error: 'Montant de commande invalide' });

        const circuit = await circuitOuvert(supabase, 'ikeepay');
        if (circuit.ouvert) {
            return res.status(503).json({ error: `Paiement temporairement indisponible, réessayez dans ${Math.ceil(circuit.retryAfterSeconds / 60)} min.` });
        }
        if (!process.env.IKEEPAY_PUBLIC_KEY) {
            return res.status(500).json({ error: 'Clé iKeePay manquante côté serveur (IKEEPAY_PUBLIC_KEY)' });
        }

        await signalerSucces(supabase, 'ikeepay');

        return res.status(200).json({
            success: true,
            pk: process.env.IKEEPAY_PUBLIC_KEY,
            amount: Math.round(resa.total),
            currency: 'XAF',
            order_id: resa.code,
            email: user.email
        });
    } catch (e) {
        console.error('Erreur preparer-paiement:', e.message);
        try {
            const supabase2 = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
            await signalerEchec(supabase2, 'ikeepay');
        } catch (_) {}
        return res.status(500).json({ error: e.message });
    }
};

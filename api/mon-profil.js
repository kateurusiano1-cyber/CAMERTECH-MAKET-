// api/mon-profil.js
// Remplace l'ancienne lecture directe et publique de la table `utilisateurs`
// (policy pub_utilisateurs, supprimée — elle exposait TOUS les clients à
// n'importe qui). Ici, le jeton Firebase du client est vérifié côté serveur
// et seule SA PROPRE ligne est renvoyée, avec uniquement les colonnes utiles
// (jamais mot_de_passe).

const { createClient } = require('@supabase/supabase-js');
const { verifierRequeteUtilisateur } = require('./_lib/verifierFirebaseToken');
const crypto = require('crypto');

const COLONNES_PUBLIQUES = 'id,nom,email,telephone,points,created_at,firebase_uid,politique_acceptee_le';

// Taux de conversion fidélité → bon de réduction : 100 points = 500 FCFA
// (soit 1 point = 5 FCFA). Conversion par palier de 100 points uniquement,
// pour éviter des bons à des montants bizarres (ex: 37 FCFA).
const POINTS_PAR_PALIER = 100;
const FCFA_PAR_PALIER = 500;

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

        return res.status(400).json({ error: 'Action inconnue' });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
};

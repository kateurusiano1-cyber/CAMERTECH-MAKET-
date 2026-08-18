// api/mon-profil.js
// Remplace l'ancienne lecture directe et publique de la table `utilisateurs`
// (policy pub_utilisateurs, supprimée — elle exposait TOUS les clients à
// n'importe qui). Ici, le jeton Firebase du client est vérifié côté serveur
// et seule SA PROPRE ligne est renvoyée, avec uniquement les colonnes utiles
// (jamais mot_de_passe).

const { createClient } = require('@supabase/supabase-js');
const { verifierRequeteUtilisateur } = require('./_lib/verifierFirebaseToken');

const COLONNES_PUBLIQUES = 'id,nom,email,telephone,points,created_at,firebase_uid,politique_acceptee_le';

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Méthode non autorisée' });

    const uid = await verifierRequeteUtilisateur(req);
    if (!uid) return res.status(401).json({ error: 'Session invalide, reconnecte-toi' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase
        .from('utilisateurs')
        .select(COLONNES_PUBLIQUES)
        .eq('firebase_uid', uid)
        .single();

    if (error || !data) return res.status(404).json({ error: 'Profil introuvable' });
    return res.status(200).json({ profil: data });
};

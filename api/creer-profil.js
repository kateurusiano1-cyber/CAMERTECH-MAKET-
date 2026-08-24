// api/creer-profil.js
// Crée ou met à jour le profil du client connecté. Passe par le serveur
// (clé service, contourne RLS de façon contrôlée) car la clé publique
// (anon) n'a plus le droit d'écrire dans utilisateurs depuis le
// durcissement RLS — exactement le même principe que api/mon-profil.js
// pour la lecture.

const { createClient } = require('@supabase/supabase-js');
const { verifierRequeteUtilisateur } = require('./_lib/verifierFirebaseToken');

const COLONNES_PUBLIQUES = 'id,nom,email,telephone,points,created_at,firebase_uid,politique_acceptee_le';

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

    const uid = await verifierRequeteUtilisateur(req);
    if (!uid) return res.status(401).json({ error: 'Session invalide, reconnecte-toi' });

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { nom, telephone, email, politiqueAcceptee } = body || {};
        if (!telephone) return res.status(400).json({ error: 'Numéro de téléphone requis' });

        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

        // Règle 1 : un email ne peut être associé qu'à un seul compte.
        if (email) {
            const { data: memeEmail } = await supabase.from('utilisateurs').select('firebase_uid').eq('email', email).neq('firebase_uid', uid);
            if (memeEmail && memeEmail.length > 0) {
                return res.status(409).json({ error: 'Un compte existe déjà avec cet email. Connecte-toi plutôt avec ce compte.' });
            }
        }

        // Règle 2 : un même numéro de téléphone peut être partagé par 3 comptes maximum.
        const { data: memeTel } = await supabase.from('utilisateurs').select('firebase_uid').eq('telephone', telephone).neq('firebase_uid', uid);
        if (memeTel && memeTel.length >= 3) {
            return res.status(409).json({ error: 'Ce numéro de téléphone est déjà utilisé par 3 comptes (maximum atteint).' });
        }

        const { data, error } = await supabase.from('utilisateurs').upsert([{
            firebase_uid: uid,
            nom: nom || 'Client',
            telephone,
            email: email || null,
            politique_acceptee_le: politiqueAcceptee ? new Date().toISOString() : null
        }], { onConflict: 'firebase_uid' }).select(COLONNES_PUBLIQUES).single();

        if (error) throw error;
        return res.status(200).json({ profil: data });
    } catch (e) {
        console.error('Erreur creer-profil:', e.message);
        return res.status(500).json({ error: e.message || 'Erreur serveur' });
    }
};

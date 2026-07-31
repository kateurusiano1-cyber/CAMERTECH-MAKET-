// api/admin-reset-password.js
// Permet à un admin connecté (vérifié côté app) de fixer un nouveau mot de
// passe pour un client, sans jamais avoir à lire ou stocker son ancien mot
// de passe. Utilise la clé service, jamais exposée au navigateur.

const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { utilisateur_id, nouveau_mdp } = body || {};

    if (!utilisateur_id || !nouveau_mdp) return res.status(400).json({ error: 'Paramètres manquants' });
    if (String(nouveau_mdp).length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 min)' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { error } = await supabase.from('utilisateurs').update({ mot_de_passe: nouveau_mdp }).eq('id', utilisateur_id);
    if (error) return res.status(500).json({ error: 'Erreur mise à jour' });

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('Erreur admin-reset-password:', e);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

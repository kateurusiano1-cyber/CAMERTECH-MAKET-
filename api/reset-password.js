// api/reset-password.js
// Vérifie le code de réinitialisation ET change le mot de passe côté serveur,
// avec la clé service (jamais exposée au navigateur). Le client ne peut plus
// modifier un mot de passe ou lire les codes directement.

const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { utilisateur_id, code, nouveau_mdp } = body || {};

    if (!utilisateur_id || !code || !nouveau_mdp) {
      return res.status(400).json({ error: 'Paramètres manquants' });
    }
    if (String(code).length !== 6) return res.status(400).json({ error: 'Code invalide' });
    if (String(nouveau_mdp).length < 6) return res.status(400).json({ error: 'Mot de passe trop court' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: reset } = await supabase
      .from('password_resets')
      .select('*')
      .eq('utilisateur_id', utilisateur_id)
      .eq('code', String(code))
      .eq('utilise', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!reset || new Date(reset.expire_at) < new Date()) {
      return res.status(400).json({ error: 'Code invalide ou expiré' });
    }

    const { error: updErr } = await supabase
      .from('utilisateurs')
      .update({ mot_de_passe: nouveau_mdp })
      .eq('id', utilisateur_id);
    if (updErr) return res.status(500).json({ error: 'Erreur mise à jour' });

    await supabase.from('password_resets').update({ utilise: true }).eq('id', reset.id);

    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('Erreur reset-password:', e);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
};

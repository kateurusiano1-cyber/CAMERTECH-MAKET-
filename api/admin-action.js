// api/admin-action.js
// Point d'entrée unique pour toutes les écritures admin qui étaient avant
// faites directement depuis le navigateur avec la clé Supabase publique
// (anon) via des policies RLS "ALL / true" — donc utilisables par
// n'importe qui, pas seulement l'admin. Cette route vérifie le jeton admin
// signé (le même que pour la connexion admin) puis utilise la clé service
// role côté serveur, qui n'est jamais exposée au navigateur.
//
// Body attendu : { ressource, action, id?, payload? }
// Combinaisons autorisées, volontairement en liste blanche stricte :
//   products     : insert | update | delete
//   bannieres    : insert | update | delete
//   avis         : update (uniquement le champ "valide") | delete
//   reservations : update (uniquement le champ "statut")
//   utilisateurs : list   (lecture seule, pour le tableau de bord admin)
//                  delete (profil Supabase + compte de connexion Firebase)

const { createClient } = require('@supabase/supabase-js');
const { verifierRequeteAdmin } = require('./_lib/adminSession');
const { envoyerPushUtilisateur } = require('./_lib/envoyerPush');

const TABLE_REELLE = { bannieres: 'bannières' }; // nom réel de la table en base

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

    const session = verifierRequeteAdmin(req, process.env.ADMIN_SESSION_SECRET);
    if (!session) return res.status(401).json({ error: 'Accès réservé à l\'administrateur' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { ressource, action, id, payload } = body || {};
        const table = TABLE_REELLE[ressource] || ressource;

        // utilisateurs : lecture seule, pour le tableau de bord admin
        if (ressource === 'utilisateurs' && action === 'list') {
            const { data, error } = await supabase
                .from('utilisateurs')
                .select('id,nom,email,telephone,points,created_at,firebase_uid,politique_acceptee_le')
                .order('created_at', { ascending: false });
            if (error) throw error;
            return res.status(200).json({ data });
        }

        // feedback_produits : lecture seule agrégée, pour le tableau de bord
        // admin (module de personnalisation en fiche produit).
        if (ressource === 'feedback_produits' && action === 'stats') {
            const { data, error } = await supabase
                .from('feedback_produits')
                .select('choix, categorie, produit_nom, created_at')
                .order('created_at', { ascending: false })
                .limit(2000);
            if (error) throw error;

            const parChoix = {};
            const parProduit = {};
            for (const r of data) {
                parChoix[r.choix] = (parChoix[r.choix] || 0) + 1;
                if (r.produit_nom) {
                    const cle = `${r.produit_nom}|${r.choix}`;
                    parProduit[cle] = (parProduit[cle] || 0) + 1;
                }
            }
            return res.status(200).json({ total: data.length, parChoix, parProduit, recents: data.slice(0, 30) });
        }

        if (ressource === 'products' && action === 'insert') {
            const { data, error } = await supabase.from('products').insert([payload]).select().single();
            if (error) throw error;
            return res.status(200).json({ data });
        }
        if (ressource === 'products' && action === 'update') {
            if (!id) return res.status(400).json({ error: 'id manquant' });
            const { data, error } = await supabase.from('products').update(payload).eq('id', id).select().single();
            if (error) throw error;
            return res.status(200).json({ data });
        }
        if (ressource === 'products' && action === 'delete') {
            if (!id) return res.status(400).json({ error: 'id manquant' });
            const { error } = await supabase.from('products').delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ ok: true });
        }

        if (ressource === 'bannieres' && action === 'insert') {
            const { data, error } = await supabase.from(table).insert([payload]).select().single();
            if (error) throw error;
            return res.status(200).json({ data });
        }
        if (ressource === 'bannieres' && action === 'update') {
            if (!id) return res.status(400).json({ error: 'id manquant' });
            const { data, error } = await supabase.from(table).update(payload).eq('id', id).select().single();
            if (error) throw error;
            return res.status(200).json({ data });
        }
        if (ressource === 'bannieres' && action === 'delete') {
            if (!id) return res.status(400).json({ error: 'id manquant' });
            const { error } = await supabase.from(table).delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ ok: true });
        }

        if (ressource === 'avis' && action === 'update') {
            if (!id) return res.status(400).json({ error: 'id manquant' });
            // Liste blanche stricte : seul le champ "valide" est modifiable ici.
            const { data, error } = await supabase.from('avis').update({ valide: !!payload?.valide }).eq('id', id).select().single();
            if (error) throw error;
            return res.status(200).json({ data });
        }
        if (ressource === 'avis' && action === 'delete') {
            if (!id) return res.status(400).json({ error: 'id manquant' });
            const { error } = await supabase.from('avis').delete().eq('id', id);
            if (error) throw error;
            return res.status(200).json({ ok: true });
        }

        if (ressource === 'reservations' && action === 'update') {
            if (!id) return res.status(400).json({ error: 'id manquant' });
            // Liste blanche stricte : seul le statut est modifiable ici.
            const { data, error } = await supabase.from('reservations').update({ statut: payload?.statut }).eq('id', id).select().single();
            if (error) throw error;
            if (data?.utilisateur_id && data?.statut) {
                const messages = {
                    'en attente': { titre: '⏳ Commande en préparation', corps: `Ta commande ${data.code} est en préparation.` },
                    'livre': { titre: '🚚 Commande livrée !', corps: `Ta commande ${data.code} a été livrée. Merci pour ta confiance !` },
                    'annule': { titre: '❌ Commande annulée', corps: `Ta commande ${data.code} a été annulée.` }
                };
                const msg = messages[data.statut];
                if (msg) {
                    try { await envoyerPushUtilisateur(supabase, data.utilisateur_id, { ...msg, url: '/' }); }
                    catch (e) { console.error('Erreur push statut:', e.message); }
                }
            }
            return res.status(200).json({ data });
        }

        if (ressource === 'utilisateurs' && action === 'delete') {
            if (!id) return res.status(400).json({ error: 'id manquant' });
            const { data: profil, error: errLecture } = await supabase.from('utilisateurs').select('firebase_uid,email').eq('id', id).single();
            if (errLecture || !profil) return res.status(404).json({ error: 'Client introuvable' });

            // On détache (jamais supprime) l'historique de commandes du
            // client — l'historique/comptabilité reste, seul le lien vers
            // le compte disparaît.
            await supabase.from('reservations').update({ utilisateur_id: null }).eq('utilisateur_id', id);
            // Nettoyage best-effort des favoris s'ils existent (table optionnelle).
            try { await supabase.from('favoris').delete().eq('utilisateur_id', id); } catch (_) {}

            const { error: errSuppr } = await supabase.from('utilisateurs').delete().eq('id', id);
            if (errSuppr) throw errSuppr;
            // Le compte de connexion Firebase n'est PAS supprimé ici (clé de
            // service bloquée par la politique Google) — on renvoie ses
            // coordonnées pour une suppression manuelle en 1 clic dans la
            // console Firebase (Authentication → Users).
            return res.status(200).json({ ok: true, firebase_uid: profil.firebase_uid, email: profil.email });
        }

        return res.status(400).json({ error: 'Combinaison ressource/action non autorisée' });
    } catch (e) {
        console.error('Erreur admin-action:', e);
        return res.status(500).json({ error: 'Erreur serveur' });
    }
};

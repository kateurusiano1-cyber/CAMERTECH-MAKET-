// api/_lib/telegramWebhook.js  (appelé par api/webhook-ikeepay.js quand l'adresse contient ?canal=telegram)
// Vercel Hobby limite à 12 fonctions : ce code vit donc dans _lib, qui ne compte pas.
// Reçoit les clics sur les boutons du groupe Telegram (« Je prends », « En
// route », « Livrée », « Problème ») et les commandes /encours, /id, /aide.
//
// Sécurité :
//   1. Telegram renvoie, à chaque appel, le secret choisi lors du setWebhook
//      (en-tête X-Telegram-Bot-Api-Secret-Token) : sans lui, on refuse.
//   2. Les boutons ne sont acceptés QUE s'ils viennent du groupe configuré
//      (TELEGRAM_CHAT_ID) : la liste des membres du groupe fait office
//      de liste des personnes autorisées.
//   3. Seul le livreur qui a pris une commande peut la passer « en route »
//      ou « livrée » ; la prise est atomique (le premier qui clique gagne).
// On répond TOUJOURS 200 à Telegram (sinon il réessaie en boucle).

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const T = require('./telegram');
const { envoyerPushUtilisateur } = require('./envoyerPush');
const CONFIG = require('../../config.js');

function secretValide(recu, attendu) {
    if (!recu || !attendu) return false;
    const a = Buffer.from(String(recu));
    const b = Buffer.from(String(attendu));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function nomAffiche(from) {
    const prenom = (from?.first_name || '').trim();
    const initiale = from?.last_name ? ' ' + from.last_name.trim().charAt(0) + '.' : '';
    return (prenom + initiale).trim() || from?.username || 'Livreur';
}

const colonneManquante = (error) => !!error && /column|schema cache/i.test(error.message || '');
const MSG_BASE_NON_PRETE = '⚠️ La base de données n\'est pas encore prête (colonnes de livraison manquantes). Exécuter le fichier SQL du guide, puis réessayer.';

async function traiterBouton(supabase, cq, cfg) {
    const msg = cq.message;
    if (!msg || String(msg.chat?.id) !== cfg.chatId) {
        return T.repondreBouton(cq.id, 'Action non autorisée dans cette discussion.', true);
    }
    const m = /^k:(pris|route|livree|prob):([A-Za-z0-9-]{4,30})$/.exec(cq.data || '');
    if (!m) return T.repondreBouton(cq.id, 'Bouton inconnu.');
    const [, action, code] = m;

    const { data: resa } = await supabase.from('reservations').select('*').eq('code', code).single();
    if (!resa) return T.repondreBouton(cq.id, 'Commande introuvable.', true);

    const retrait = T.estRetrait(resa, CONFIG.ZONES_COUVERTES);
    const qui = nomAffiche(cq.from);
    const monId = String(cq.from.id);
    const prisPar = resa.livreur_telegram_id ? String(resa.livreur_telegram_id) : null;
    const maintenant = new Date().toISOString();

    if (resa.statut === 'annule') {
        await T.modifierMessage(msg.message_id, T.texteCommande(resa, { retrait, etat: '❌ <b>Commande annulée</b> — ne pas livrer.' }), []);
        return T.repondreBouton(cq.id, 'Commande annulée : ne pas livrer.', true);
    }
    if (resa.statut === 'livre') return T.repondreBouton(cq.id, 'Cette commande est déjà livrée.');
    if (!['valide', 'en attente'].includes(resa.statut)) return T.repondreBouton(cq.id, 'Cette commande n\'est pas payée.', true);

    const editer = (r) => T.modifierMessage(msg.message_id, T.texteCommande(r, { retrait, etat: T.ligneEtat(r) }), T.boutonsPour(r, retrait));
    const reservePar = () => `Seul ${resa.livreur_nom || 'celui qui l\'a prise'} peut faire ça.`;

    if (action === 'pris') {
        if (prisPar && prisPar !== monId) return T.repondreBouton(cq.id, `Déjà prise par ${resa.livreur_nom || 'un collègue'}.`, true);
        if (prisPar === monId) return T.repondreBouton(cq.id, 'Tu l\'as déjà prise.');
        const { data: lignes, error } = await supabase.from('reservations')
            .update({ livreur_nom: qui, livreur_telegram_id: cq.from.id, pris_en_charge_le: maintenant, etape_livraison: 'pris' })
            .eq('code', code).is('livreur_telegram_id', null).select();
        if (error) {
            console.error('Telegram « pris » :', error.message);
            return T.repondreBouton(cq.id, colonneManquante(error) ? MSG_BASE_NON_PRETE : 'Erreur, réessaie dans un instant.', true);
        }
        if (!lignes || !lignes.length) {
            // Quelqu'un a cliqué à la même seconde : on relit pour dire qui.
            const { data: r } = await supabase.from('reservations').select('livreur_nom').eq('code', code).single();
            return T.repondreBouton(cq.id, `Déjà prise par ${r?.livreur_nom || 'un collègue'}.`, true);
        }
        await editer(lignes[0]);
        return T.repondreBouton(cq.id, 'C\'est à toi 👍');
    }

    if (action === 'route') {
        if (retrait) return T.repondreBouton(cq.id, 'Retrait en agence : pas de livraison.');
        if (prisPar !== monId) return T.repondreBouton(cq.id, prisPar ? reservePar() : 'Prends d\'abord la commande.', true);
        const { data: lignes, error } = await supabase.from('reservations')
            .update({ etape_livraison: 'en_route', en_livraison_le: maintenant }).eq('code', code).select();
        if (error || !lignes?.length) {
            console.error('Telegram « route » :', error?.message);
            return T.repondreBouton(cq.id, colonneManquante(error) ? MSG_BASE_NON_PRETE : 'Erreur, réessaie.', true);
        }
        await editer(lignes[0]);
        try {
            await envoyerPushUtilisateur(supabase, resa.utilisateur_id, {
                titre: '🚚 Ta commande est en route', corps: `Ta commande ${code} est en route vers toi.`, url: '/'
            });
        } catch (e) { console.error('Push « en route » :', e.message); }
        return T.repondreBouton(cq.id, 'Client prévenu 🚚');
    }

    if (action === 'livree') {
        if (prisPar !== monId) return T.repondreBouton(cq.id, prisPar ? reservePar() : 'Prends d\'abord la commande.', true);
        // 1) Le statut (colonne existante) : jamais bloqué par la nouvelle base.
        const { error: errStatut } = await supabase.from('reservations').update({ statut: 'livre' }).eq('code', code);
        if (errStatut) {
            console.error('Telegram « livrée » (statut) :', errStatut.message);
            return T.repondreBouton(cq.id, 'Erreur, réessaie.', true);
        }
        // 2) Les infos de livraison (nouvelles colonnes), en best-effort.
        try {
            const { error } = await supabase.from('reservations').update({ etape_livraison: 'livree', livre_le: maintenant }).eq('code', code);
            if (error) console.error('Telegram « livrée » (détails) :', error.message);
        } catch (e) { console.error('Telegram livrée détails :', e.message); }
        await editer({ ...resa, statut: 'livre', etape_livraison: 'livree', livre_le: maintenant });
        try {
            await envoyerPushUtilisateur(supabase, resa.utilisateur_id, {
                titre: '🚚 Commande livrée !', corps: `Ta commande ${code} a été livrée. Merci pour ta confiance !`, url: '/'
            });
        } catch (e) { console.error('Push « livrée » :', e.message); }
        return T.repondreBouton(cq.id, 'Bravo, livraison enregistrée ✅');
    }

    if (action === 'prob') {
        try {
            const { error } = await supabase.from('reservations').update({ etape_livraison: 'probleme' }).eq('code', code);
            if (error) console.error('Telegram « problème » :', error.message);
        } catch (e) { console.error('Telegram problème :', e.message); }
        await editer({ ...resa, etape_livraison: 'probleme' });
        // Un nouveau message (et non une modification) pour que le groupe soit alerté.
        await T.envoyerMessage(`⚠️ <b>Problème sur ${T.echapper(code)}</b> signalé par ${T.echapper(qui)}.\nUn admin doit contacter le client (${T.echapper(resa.nom_client || '')}${resa.telephone ? ' · ' + T.echapper(resa.telephone) : ''}).`);
        return T.repondreBouton(cq.id, 'Problème signalé aux admins ⚠️');
    }
}

async function traiterTexte(supabase, message, cfg) {
    const texte = String(message.text || '').trim();
    if (!texte.startsWith('/')) return;
    const cmd = texte.split(/[\s@]/)[0].toLowerCase();
    const chatId = message.chat?.id;

    // /id marche partout : sert à découvrir l'identifiant du groupe lors de la mise en place.
    if (cmd === '/id') {
        return T.repondreTexte(chatId, `Identifiant de cette discussion : <code>${T.echapper(chatId)}</code>`);
    }
    // Le reste est réservé au groupe configuré. Au lieu de rester muet (on ne saurait pas pourquoi),
    // le robot dit ce qui ne va pas — sans rien révéler sur les commandes.
    if (['/aide', '/start', '/encours'].includes(cmd)) {
        if (!cfg) { console.error('Telegram : TELEGRAM_CHAT_ID absente ou non prise en compte (message reçu du groupe ' + chatId + ')'); return T.repondreTexte(chatId, '⚠️ Ce robot est réservé à l\'équipe Kapmaket.'); }
        if (String(chatId) !== cfg.chatId) {
            console.error('Telegram : message reçu d\'un groupe non enregistré (' + chatId + '), groupe attendu : ' + cfg.chatId + ' — vérifier TELEGRAM_CHAT_ID');
            return T.repondreTexte(chatId, '⚠️ Ce robot est réservé à l\'équipe Kapmaket.');
        }
    }
    if (!cfg || String(chatId) !== cfg.chatId) return;

    if (cmd === '/aide' || cmd === '/start') {
        return T.repondreTexte(chatId, [
            '🤖 <b>Bot commandes Kapmaket</b>',
            'Chaque commande payée arrive ici avec un bouton <b>« Je prends cette commande »</b>.',
            '/encours — commandes payées pas encore livrées',
            '/id — identifiant de cette discussion'
        ].join('\n'));
    }

    if (cmd === '/encours') {
        const { data, error } = await supabase.from('reservations').select('*')
            .in('statut', ['valide', 'en attente']).order('created_at', { ascending: true }).limit(30);
        if (error) { console.error('/encours :', error.message); return T.repondreTexte(chatId, 'Erreur de lecture, réessaie.'); }
        const liste = (data || []).filter((r) => r.etape_livraison !== 'livree');
        if (!liste.length) return T.repondreTexte(chatId, '✅ Aucune commande en attente.');
        const lignes = liste.slice(0, 15).map((r, i) => {
            const retrait = T.estRetrait(r, CONFIG.ZONES_COUVERTES);
            const etat = r.etape_livraison === 'pris' ? `🙋 ${T.echapper(r.livreur_nom)}`
                : r.etape_livraison === 'en_route' ? `🚚 ${T.echapper(r.livreur_nom)}`
                : r.etape_livraison === 'probleme' ? '⚠️ problème'
                : '⏳ non prise';
            return `${i + 1}. <b>${T.echapper(r.code)}</b> — ${T.echapper(r.nom_client || 'Client')} — ${T.fmt(r.total)} F — ${retrait ? '🏪 retrait' : '📍 ' + T.echapper(r.zone_livraison)} — ${etat}`;
        });
        if (liste.length > 15) lignes.push(`… et ${liste.length - 15} de plus (voir le tableau de bord).`);
        return T.repondreTexte(chatId, `📋 <b>${liste.length} commande(s) à traiter</b>\n` + lignes.join('\n'));
    }
}

module.exports = async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

    if (!secretValide(req.headers['x-telegram-bot-api-secret-token'], (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim())) {
        return res.status(401).json({ error: 'Non autorisé' });
    }

    try {
        const update = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        const cfg = T.configurer(); // peut être null tant que TELEGRAM_CHAT_ID n'est pas posé
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

        if (update.callback_query) {
            if (!cfg) await T.repondreBouton(update.callback_query.id, 'Bot pas encore configuré (TELEGRAM_CHAT_ID).', true);
            else await traiterBouton(supabase, update.callback_query, cfg);
        } else if (update.message?.text) {
            await traiterTexte(supabase, update.message, cfg);
        }
    } catch (e) {
        console.error('Erreur telegram-webhook :', e.message);
    }
    return res.status(200).json({ ok: true });
};

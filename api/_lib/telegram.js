// api/_lib/telegram.js
// Alertes de commande dans un groupe Telegram (admins + livreurs).
//
// Variables d'environnement (Vercel) :
//   TELEGRAM_BOT_TOKEN       jeton donné par @BotFather
//   TELEGRAM_CHAT_ID         identifiant du groupe (nombre négatif)
//   TELEGRAM_WEBHOOK_SECRET  secret choisi par vous, vérifié sur chaque appel de Telegram
//
// Règle d'or : AUCUNE fonction d'ici ne doit jamais faire échouer une
// validation de paiement. Tout est enveloppé : en cas de souci on journalise
// et on continue (les notifications push existantes restent en place).

const API = 'https://api.telegram.org';

function configurer() {
    // trim() : un espace ou un retour à la ligne collé par erreur dans Vercel ne doit pas tout casser.
    const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
    return token && chatId ? { token, chatId } : null;
}

const echapper = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('fr-FR').replace(/[\u202f\u00a0]/g, ' ');

async function appel(token, methode, corps, delaiMs = 3500) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), delaiMs);
    try {
        const r = await fetch(`${API}/bot${token}/${methode}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(corps),
            signal: ctrl.signal
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) {
            const e = new Error(`Telegram ${methode} : ${j.description || r.status}`);
            e.statut = r.status;
            throw e;
        }
        return j.result;
    } finally { clearTimeout(t); }
}

function clavier(boutons) {
    if (!boutons || !boutons.length) return { inline_keyboard: [] };
    return { inline_keyboard: boutons.map((ligne) => ligne.map((b) => ({ text: b.texte, callback_data: b.data }))) };
}

// Envoie un message dans le groupe (2 tentatives max). Renvoie le message
// Telegram (avec message_id) ou null — ne lève jamais d'erreur.
async function envoyerMessage(texte, boutons) {
    const cfg = configurer();
    if (!cfg) return null;
    for (let essai = 1; essai <= 2; essai++) {
        try {
            return await appel(cfg.token, 'sendMessage', {
                chat_id: cfg.chatId, text: texte, parse_mode: 'HTML',
                disable_web_page_preview: true, reply_markup: clavier(boutons)
            });
        } catch (e) {
            console.error(`Telegram sendMessage (essai ${essai}) :`, e.message);
            if (e.statut && e.statut >= 400 && e.statut < 500 && e.statut !== 429) break; // inutile de réessayer
        }
    }
    return null;
}

async function modifierMessage(messageId, texte, boutons) {
    const cfg = configurer();
    if (!cfg || !messageId) return false;
    try {
        await appel(cfg.token, 'editMessageText', {
            chat_id: cfg.chatId, message_id: messageId, text: texte, parse_mode: 'HTML',
            disable_web_page_preview: true, reply_markup: clavier(boutons)
        });
        return true;
    } catch (e) {
        // « message is not modified » est normal si on clique deux fois.
        if (!/not modified/i.test(e.message)) console.error('Telegram editMessageText :', e.message);
        return false;
    }
}

async function repondreBouton(callbackId, texte, alerte) {
    const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!token) return;
    try { await appel(token, 'answerCallbackQuery', { callback_query_id: callbackId, text: texte || '', show_alert: !!alerte }, 3000); }
    catch (e) { console.error('Telegram answerCallbackQuery :', e.message); }
}

async function repondreTexte(chatId, texte) {
    const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    if (!token) return;
    try { await appel(token, 'sendMessage', { chat_id: chatId, text: texte, parse_mode: 'HTML', disable_web_page_preview: true }, 3500); }
    catch (e) { console.error('Telegram réponse :', e.message); }
}

// ---------------------------------------------------------------------
// Mise en forme d'une commande
// ---------------------------------------------------------------------
function estRetrait(resa, zonesCouvertes) {
    return !(zonesCouvertes || []).includes(resa.zone_livraison);
}

function heure(iso) {
    try { return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Douala' }); }
    catch (e) { return ''; }
}
function jour(iso) {
    try { return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', timeZone: 'Africa/Douala' }); }
    catch (e) { return ''; }
}

function lignesArticles(items) {
    const liste = Array.isArray(items) ? items : [];
    const lignes = liste.slice(0, 8).map((it) => `• ${echapper(it.qty || 1)}× ${echapper(it.name || 'Article')}${it.combo ? ' (combo ' + echapper(it.combo) + ')' : ''}`);
    if (liste.length > 8) lignes.push(`• … et ${liste.length - 8} autre(s) article(s)`);
    return lignes.join('\n') || '• (détail indisponible)';
}

// Texte complet du message de commande, avec la ligne d'état en bas.
function texteCommande(resa, { retrait, etat } = {}) {
    const l = [];
    l.push('📦 <b>COMMANDE PAYÉE — à ' + (retrait ? 'préparer (retrait)' : 'livrer') + '</b>');
    l.push(`<b>${echapper(resa.code)}</b>`);
    l.push(`👤 ${echapper(resa.nom_client || 'Client')}${resa.telephone ? ' · ' + echapper(resa.telephone) : ''}`);
    l.push(`💰 <b>${fmt(resa.total)} FCFA</b> — montant exact vérifié ✅`);
    if (retrait) {
        const lim = resa.date_limite_retrait ? ` — à retirer avant le ${jour(resa.date_limite_retrait)}` : '';
        l.push(`🏪 Retrait en agence${lim}`);
    } else {
        l.push(`🚚 Livraison à <b>${echapper(resa.zone_livraison || '—')}</b>${resa.frais_livraison ? ' (frais ' + fmt(resa.frais_livraison) + ' FCFA)' : ''}`);
    }
    l.push('🛒 Articles :\n' + lignesArticles(resa.items));
    if (resa.note) l.push('📝 ' + echapper(String(resa.note).slice(0, 300)));
    if (etat) l.push('\n' + etat);
    return l.join('\n');
}

function ligneEtat(resa) {
    const nom = echapper(resa.livreur_nom || '—');
    switch (resa.etape_livraison) {
        case 'pris': return `🙋 Pris en charge par <b>${nom}</b> à ${heure(resa.pris_en_charge_le)}`;
        case 'en_route': return `🚚 <b>${nom}</b> est en route (depuis ${heure(resa.en_livraison_le)})`;
        case 'probleme': return `⚠️ <b>Problème signalé</b> — pris en charge par ${nom}. Un admin doit intervenir.`;
        case 'livree': return `✅ <b>Livrée</b> à ${heure(resa.livre_le)} (${nom})`;
        default: return '';
    }
}

// Boutons selon l'étape (callback_data = "k:<action>:<code>", limite Telegram 64 octets)
function boutonsPour(resa, retrait) {
    const d = (a) => `k:${a}:${resa.code}`;
    switch (resa.etape_livraison) {
        case 'pris':
            return retrait
                ? [[{ texte: '✅ Remise au client', data: d('livree') }], [{ texte: '❌ Problème', data: d('prob') }]]
                : [[{ texte: '🚚 En route', data: d('route') }], [{ texte: '❌ Problème', data: d('prob') }]];
        case 'en_route':
            return [[{ texte: '✅ Livrée', data: d('livree') }], [{ texte: '❌ Problème', data: d('prob') }]];
        case 'probleme':
            return [[{ texte: retrait ? '✅ Remise au client' : '🚚 En route', data: d(retrait ? 'livree' : 'route') }], ...(retrait ? [] : [[{ texte: '✅ Livrée', data: d('livree') }]])];
        case 'livree':
            return [];
        default:
            return [[{ texte: '🙋 Je prends cette commande', data: d('pris') }]];
    }
}

// ---------------------------------------------------------------------
// Fonctions appelées par le reste du site
// ---------------------------------------------------------------------

// Commande payée au montant exact : message avec bouton « Je prends ».
async function notifierCommandePayee(supabase, resa, { retrait, dateLimiteRetrait }) {
    const complete = { ...resa, date_limite_retrait: dateLimiteRetrait || null };
    const msg = await envoyerMessage(texteCommande(complete, { retrait }), boutonsPour(complete, retrait));
    if (msg?.message_id) {
        // Mémorise le message pour pouvoir le mettre à jour ensuite. Écriture
        // à part et protégée : si la colonne n'existe pas encore, rien ne casse.
        try {
            const { error } = await supabase.from('reservations').update({ telegram_message_id: msg.message_id }).eq('code', resa.code);
            if (error) console.error('Telegram : mémorisation message_id impossible (colonne manquante ?) :', error.message);
        } catch (e) { console.error('Telegram message_id :', e.message); }
    }
    return !!msg;
}

// Paiement dont le montant ne correspond pas : à vérifier à la main.
async function notifierPaiementAVerifier(supabase, resa, { montantRecu, refFournisseur }) {
    const texte = [
        '⚠️ <b>PAIEMENT À VÉRIFIER</b>',
        `<b>${echapper(resa.code)}</b> — ${echapper(resa.nom_client || 'Client')}${resa.telephone ? ' · ' + echapper(resa.telephone) : ''}`,
        `Montant attendu : <b>${fmt(resa.total)} FCFA</b>`,
        `Montant reçu : <b>${montantRecu ? fmt(montantRecu) + ' FCFA' : 'inconnu'}</b>`,
        refFournisseur ? `Référence de paiement : ${echapper(refFournisseur)}` : '',
        'La commande n\'est <b>PAS</b> validée. Vérifier le paiement chez le prestataire de paiement avant de préparer quoi que ce soit.'
    ].filter(Boolean).join('\n');
    const msg = await envoyerMessage(texte);
    try {
        const { error } = await supabase.from('reservations').update({ paiement_a_verifier: true }).eq('code', resa.code);
        if (error) console.error('Telegram : marquage paiement_a_verifier impossible (colonne manquante ?) :', error.message);
    } catch (e) { console.error('Telegram paiement_a_verifier :', e.message); }
    return !!msg;
}

// Appelée quand l'admin change le statut depuis le tableau de bord : on met
// à jour le message du groupe pour que tout le monde voie la même chose.
async function synchroniserStatut(resa, zonesCouvertes) {
    if (!resa?.telegram_message_id) return;
    const retrait = estRetrait(resa, zonesCouvertes);
    let etat = '';
    if (resa.statut === 'livre') etat = '✅ <b>Marquée livrée</b> depuis le tableau de bord.';
    else if (resa.statut === 'annule') etat = '❌ <b>Commande annulée</b> depuis le tableau de bord — ne pas livrer.';
    else return;
    await modifierMessage(resa.telegram_message_id, texteCommande(resa, { retrait, etat }), []);
}

module.exports = {
    configurer, echapper, fmt, envoyerMessage, modifierMessage, repondreBouton, repondreTexte,
    estRetrait, texteCommande, ligneEtat, boutonsPour, heure,
    notifierCommandePayee, notifierPaiementAVerifier, synchroniserStatut
};

// api/_lib/demandes.js
// Enregistre, de façon anonyme, ce que les visiteurs demandent à l'assistant (« miroir de la demande »).
// Aucune donnée personnelle n'est conservée : pas de nom, pas de numéro, pas d'e-mail, pas de code de commande.
// L'enregistrement ne doit JAMAIS ralentir ni casser l'assistant : en cas de souci on journalise et on continue.

// Catégories que l'IA doit utiliser (mêmes mots d'un jour à l'autre = statistiques lisibles).
const INTENTIONS = ['telephone', 'chargeur', 'batterie', 'ecouteurs', 'casque', 'enceinte', 'accessoire', 'ordinateur', 'reseau', 'gaming', 'electronique', 'promo', 'livraison', 'paiement', 'commande', 'retour', 'contact', 'autre'];

const sansAccent = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// Question « nettoyée » : numéros, e-mails et codes de commande masqués, 200 caractères maximum.
function nettoyerQuestion(texte) {
    return String(texte || '')
        .replace(/CMT-[A-Za-z0-9]+/gi, '[code]')
        .replace(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;.]+/g, '[e-mail]')
        .replace(/\+?\d(?:[\s.\-]?\d){6,}/g, '[numéro]')
        .replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Mot-clé de recherche normalisé : minuscules, sans accent ni ponctuation, 60 caractères maximum.
function normaliserTerme(texte) {
    return sansAccent(String(texte || '').toLowerCase()).replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
}

function normaliserIntention(valeur) {
    const v = normaliserTerme(valeur).replace(/\s+/g, '');
    return INTENTIONS.includes(v) ? v : (v ? 'autre' : null);
}

function normaliserBudget(valeur) {
    const n = Math.round(Number(valeur));
    return Number.isFinite(n) && n >= 500 && n <= 100000000 ? n : null;
}

const sessionSure = (s) => /^[A-Za-z0-9_-]{8,64}$/.test(String(s || '')) ? String(s) : null;

// Insère une ligne dans assistant_demandes. Renvoie true/false, ne lève jamais d'erreur, délai maximum 1,5 s.
async function enregistrerDemande(supabase, { source = 'assistant', session, question, meta = {}, produitsIds = [], humain = false, modele = null }) {
    try {
        const ligne = {
            source,
            session: sessionSure(session),
            question: nettoyerQuestion(question),
            intention: normaliserIntention(meta.intention),
            produit_recherche: normaliserTerme(meta.produit_recherche) || null,
            budget: normaliserBudget(meta.budget),
            trouve: typeof meta.trouve === 'boolean' ? meta.trouve : null,
            produits_ids: (produitsIds || []).map((x) => String(x).slice(0, 64)).slice(0, 5),
            humain: !!humain,
            modele: modele ? String(modele).slice(0, 60) : null
        };
        const attente = new Promise((resolve) => setTimeout(() => resolve({ error: { message: 'délai dépassé (1,5 s)' } }), 1500));
        const { error } = await Promise.race([supabase.from('assistant_demandes').insert([ligne]), attente]);
        if (error) { console.error('Demandes : enregistrement impossible (table créée ? 6-SQL-demandes-clients.sql) :', error.message); return false; }
        return true;
    } catch (e) {
        console.error('Demandes : erreur d\'enregistrement :', e.message);
        return false;
    }
}

module.exports = { INTENTIONS, nettoyerQuestion, normaliserTerme, normaliserIntention, normaliserBudget, enregistrerDemande };

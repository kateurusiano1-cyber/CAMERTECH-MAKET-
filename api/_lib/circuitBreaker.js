// api/_lib/circuitBreaker.js
// Pattern "circuit breaker" avec 3 états, comme la version originale (Netflix
// Hystrix) :
//   FERMÉ     : tout passe normalement.
//   OUVERT    : trop d'échecs récents → on bloque tout, sans même essayer.
//   SEMI-OUVERT : le délai de repos est passé → on laisse passer UNE SEULE
//                 requête "test" pour voir si le service est revenu ; les
//                 autres restent bloquées en attendant le verdict de ce test.
// Ça évite qu'un pic de requêtes ne re-sature un service tout juste rétabli.

const PROBE_WINDOW_MS = 20000; // durée pendant laquelle UNE requête test a le champ libre

// Vérifie si le circuit est ouvert (service en pause). À appeler AVANT
// d'essayer d'appeler le service externe.
// Retourne { ouvert: false } si l'appel est autorisé (circuit fermé, ou cette
// requête a été choisie comme requête test en semi-ouvert).
async function circuitOuvert(supabase, service, maxEchecs = 5) {
    const { data } = await supabase.from('circuit_breaker').select('*').eq('service', service).single();

    // Circuit fermé (jamais ouvert, ou pas assez d'échecs) : tout passe.
    if (!data?.ouvert_jusqu) return { ouvert: false };

    const maintenant = new Date();
    const finPause = new Date(data.ouvert_jusqu);

    // Toujours dans la fenêtre de pause : on bloque, sans essayer.
    if (finPause > maintenant) {
        return { ouvert: true, retryAfterSeconds: Math.ceil((finPause - maintenant) / 1000) };
    }

    // Le délai est passé → semi-ouvert. On tente de "réserver" la place de
    // requête test via un verrou optimiste : seule la requête qui réussit à
    // décaler ouvert_jusqu (en partant de la valeur qu'on vient de lire) est
    // autorisée à tester le service ; les autres arrivées en même temps
    // échoueront ce verrou et resteront bloquées.
    const { data: reserve } = await supabase
        .from('circuit_breaker')
        .update({ ouvert_jusqu: new Date(Date.now() + PROBE_WINDOW_MS).toISOString(), updated_at: new Date().toISOString() })
        .eq('service', service)
        .eq('ouvert_jusqu', data.ouvert_jusqu) // n'agit que si personne n'a déjà pris la place
        .select();

    if (reserve && reserve.length > 0) {
        return { ouvert: false }; // cette requête est la requête test — autorisée
    }
    return { ouvert: true, retryAfterSeconds: Math.ceil(PROBE_WINDOW_MS / 1000) }; // quelqu'un d'autre teste déjà
}

// À appeler après un échec d'appel au service externe (y compris un échec de
// la requête test en semi-ouvert, qui remet le circuit en pause complète).
async function signalerEchec(supabase, service, maxEchecs = 5, cooldownMinutes = 5) {
    const { data } = await supabase.from('circuit_breaker').select('*').eq('service', service).single();
    const echecs = (data?.echecs || 0) + 1;
    const ouvert_jusqu = echecs >= maxEchecs ? new Date(Date.now() + cooldownMinutes * 60000).toISOString() : null;
    await supabase.from('circuit_breaker').upsert({ service, echecs, ouvert_jusqu, updated_at: new Date().toISOString() });
}

// À appeler après un succès — referme le circuit et réinitialise le compteur.
async function signalerSucces(supabase, service) {
    await supabase.from('circuit_breaker').upsert({ service, echecs: 0, ouvert_jusqu: null, updated_at: new Date().toISOString() });
}

module.exports = { circuitOuvert, signalerEchec, signalerSucces };

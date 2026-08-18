// api/_lib/verifierFirebaseToken.js
// Vérifie côté serveur qu'un jeton d'identité Firebase (envoyé par le
// navigateur via fbUser.getIdToken()) est authentique et n'a pas expiré,
// sans dépendre du SDK firebase-admin ni d'aucune clé secrète : la
// vérification se fait par signature contre les clés publiques de Google.
// Retourne l'UID Firebase si valide, sinon null.

const { createRemoteJWKSet, jwtVerify } = require('jose');

const JWKS = createRemoteJWKSet(
    new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

// L'ID de projet Firebase n'est pas un secret (déjà visible côté client
// dans index.html) : on le garde ici en repli si la variable d'env est absente.
const PROJET_PAR_DEFAUT = 'camertech-maket';

async function verifierFirebaseToken(idToken) {
    if (!idToken || typeof idToken !== 'string') return null;
    const projet = process.env.FIREBASE_PROJECT_ID || PROJET_PAR_DEFAUT;
    try {
        const { payload } = await jwtVerify(idToken, JWKS, {
            issuer: `https://securetoken.google.com/${projet}`,
            audience: projet,
        });
        if (!payload.sub || !payload.user_id) return null;
        return payload.sub; // = uid Firebase
    } catch (e) {
        return null;
    }
}

// Lit l'en-tête Authorization: Bearer <idToken> et retourne l'UID vérifié.
async function verifierRequeteUtilisateur(req) {
    const auth = req.headers['authorization'] || '';
    const idToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    return verifierFirebaseToken(idToken);
}

module.exports = { verifierFirebaseToken, verifierRequeteUtilisateur };

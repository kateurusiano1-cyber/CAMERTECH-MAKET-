// api/_lib/adminSession.js
// Jetons de session admin signés (HMAC-SHA256), sans dépendance externe.
// Remplace l'ancien système où "isAdmin=true" était juste une variable JS
// que n'importe qui pouvait forcer depuis la console du navigateur.

const crypto = require('crypto');

function b64url(str) {
    return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Buffer.from(str, 'base64').toString('utf8');
}

// Crée un jeton { id, wa, exp } signé. Valable `dureeSecondes` à partir de maintenant.
function creerToken(payload, secret, dureeSecondes) {
    const data = { ...payload, exp: Math.floor(Date.now() / 1000) + dureeSecondes };
    const payloadB64 = b64url(JSON.stringify(data));
    const signature = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
    return `${payloadB64}.${signature}`;
}

// Vérifie un jeton : signature valide ET non expiré. Retourne le payload ou null.
function verifierToken(token, secret) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [payloadB64, signature] = token.split('.');
    if (!payloadB64 || !signature) return null;

    const signatureAttendue = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
    const sigBuf = Buffer.from(signature, 'hex');
    const attendueBuf = Buffer.from(signatureAttendue, 'hex');
    if (sigBuf.length !== attendueBuf.length || !crypto.timingSafeEqual(sigBuf, attendueBuf)) return null;

    let data;
    try { data = JSON.parse(b64urlDecode(payloadB64)); } catch (e) { return null; }
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
}

// Lit et vérifie l'en-tête "Authorization: Bearer <token>" d'une requête entrante.
// À utiliser dans toute future route serverless réservée à l'admin.
function verifierRequeteAdmin(req, secret) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    return verifierToken(token, secret);
}

module.exports = { creerToken, verifierToken, verifierRequeteAdmin };

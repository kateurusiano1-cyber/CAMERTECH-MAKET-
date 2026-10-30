// Connexion des clients (Firebase). Ce fichier n'est chargé qu'à la demande (voir chargerFirebase() dans script.js) :
// l'afficher dès l'ouverture du site retardait tout le reste, alors que la plupart des visiteurs ne se connectent pas.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, browserPopupRedirectResolver, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, confirmPasswordReset, verifyPasswordResetCode, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
const firebaseConfig = {
    apiKey: "AIzaSyCTIOt_TEhQnfhIkLiDIu2HjjhSzAMH9iE",
    authDomain: "camertech-maket.firebaseapp.com",
    projectId: "camertech-maket",
    storageBucket: "camertech-maket.firebasestorage.app",
    messagingSenderId: "54602735777",
    appId: "1:54602735777:web:21dd6c4b25133d325a50e0"
};
const firebaseApp = initializeApp(firebaseConfig);
// `initializeAuth` à la place de `getAuth` : la session reste mémorisée comme avant, mais la page auxiliaire de Google (≈135 Ko)
// n'est plus téléchargée d'office. Elle ne l'est que lors de la connexion par la fenêtre Google (résolveur passé à signInWithPopup).
window.firebaseAuth = initializeAuth(firebaseApp, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
window.googleProvider = new GoogleAuthProvider();
window.fbSignInWithPopup = (auth, provider) => signInWithPopup(auth, provider, browserPopupRedirectResolver);
window.fbSignInWithEmail = signInWithEmailAndPassword;
window.fbCreateUserWithEmail = createUserWithEmailAndPassword;
window.fbSendPasswordResetEmail = sendPasswordResetEmail;
window.fbConfirmPasswordReset = confirmPasswordReset;
window.fbVerifyPasswordResetCode = verifyPasswordResetCode;
window.fbSignOut = signOut;
window.fbOnAuthStateChanged = onAuthStateChanged;

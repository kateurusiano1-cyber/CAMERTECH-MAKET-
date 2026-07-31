-- À exécuter dans Supabase SQL Editor
-- Corrige une faille critique : n'importe qui pouvait lire TOUS les codes
-- de réinitialisation de TOUS les comptes, et changer le mot de passe de
-- n'importe quel utilisateur directement via l'API, sans connaître son code.
-- Désormais, la vérification du code et le changement de mot de passe se
-- font uniquement via la fonction serveur sécurisée api/reset-password.js.

drop policy if exists "Lecture publique pour vérification du code" on password_resets;
drop policy if exists "Mise à jour publique (marquer comme utilisé)" on password_resets;

-- La demande de code (insertion) reste publique : un visiteur doit pouvoir
-- déclencher une demande de code sans être connecté.
-- (la policy d'insertion existante est conservée)

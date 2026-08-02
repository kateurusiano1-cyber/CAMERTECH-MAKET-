-- À exécuter dans Supabase SQL Editor
-- Le téléphone n'est plus l'identifiant de connexion (c'est l'email/Firebase
-- désormais), juste une info de contact/livraison — plusieurs comptes peuvent
-- légitimement partager le même numéro. On retire la contrainte d'unicité.

alter table utilisateurs drop constraint if exists utilisateurs_telephone_key;

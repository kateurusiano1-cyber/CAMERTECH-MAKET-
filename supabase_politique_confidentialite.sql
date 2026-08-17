-- À exécuter dans Supabase SQL Editor
-- Ajoute la colonne qui enregistre le moment où l'utilisateur a coché la case
-- "J'ai lu et j'accepte la politique de confidentialité" à la création de compte
-- (email/mot de passe ET première connexion Google).

alter table utilisateurs add column if not exists politique_acceptee_le timestamptz;

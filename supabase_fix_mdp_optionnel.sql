-- À exécuter dans Supabase SQL Editor
-- Corrige le bug d'inscription : la colonne mot_de_passe était obligatoire
-- (héritage de l'ancien système), mais Firebase gère maintenant les mots de
-- passe — on n'envoie plus jamais rien dans cette colonne pour les nouveaux
-- comptes, donc elle doit devenir optionnelle.

alter table utilisateurs alter column mot_de_passe drop not null;

-- À exécuter dans Supabase SQL Editor
-- Relie chaque commande (compte OU invité) à sa session de navigation
-- anonyme (visiteurs_sessions.session_id) — sans ça, l'admin voyait un
-- visiteur anonyme naviguer sur le site d'un côté, et une commande avec
-- juste un nom/téléphone de l'autre, sans lien entre les deux pour les
-- achats invité (les comptes, eux, sont déjà reliés via utilisateur_id).

alter table reservations add column if not exists visiteur_session_id text;

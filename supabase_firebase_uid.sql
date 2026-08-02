-- À exécuter dans Supabase SQL Editor
-- Migration vers Firebase Auth comme système d'identité principal.
-- Le téléphone et le nom restent dans "utilisateurs" (infos de profil/livraison),
-- mais l'identité et le mot de passe sont désormais gérés par Firebase, plus par
-- la colonne mot_de_passe (qu'on laisse en place pour les anciens comptes, mais
-- qui n'est plus utilisée par le nouveau code).

alter table utilisateurs add column if not exists firebase_uid text unique;

-- Rend l'email obligatoire pour les nouveaux comptes (les anciens comptes sans
-- email ne sont pas affectés par cette contrainte tant qu'ils ne sont pas modifiés).
-- (rien à exécuter de plus ici : la contrainte "required" est gérée côté formulaire)

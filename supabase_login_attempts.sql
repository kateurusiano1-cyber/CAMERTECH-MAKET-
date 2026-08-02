-- À exécuter dans Supabase SQL Editor
-- Table utilisée uniquement par les fonctions serveur (clé service) pour
-- limiter les tentatives de connexion et de vérification de code.
-- Aucun accès public : ni lecture ni écriture depuis le navigateur.

create table if not exists login_attempts (
  cle text primary key,
  tentatives int not null default 0,
  bloque_jusqu timestamptz,
  updated_at timestamptz default now()
);

alter table login_attempts enable row level security;
-- Volontairement aucune policy anon créée : la table est invisible et
-- inaccessible pour la clé publique, seule la clé service (serveur) l'utilise.

-- À exécuter dans Supabase SQL Editor
-- Stocke les abonnements navigateur aux notifications push, pour prévenir
-- un client des changements de statut de sa commande même app fermée.

create table if not exists push_subscriptions (
  id uuid default gen_random_uuid() primary key,
  utilisateur_id uuid not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz default now()
);

alter table push_subscriptions enable row level security;
-- Aucune policy anon : la clé service (serveur, jeton Firebase vérifié
-- avant écriture) est le seul moyen d'accéder à cette table.

-- À exécuter dans Supabase SQL Editor
-- Table utilisée uniquement par les fonctions serveur (clé service) pour le
-- "circuit breaker" : si un service externe (Monetbil, l'IA Gemini) échoue
-- plusieurs fois de suite, on arrête de l'appeler temporairement au lieu de
-- s'acharner. Aucun accès public.

create table if not exists circuit_breaker (
  service text primary key,
  echecs int not null default 0,
  ouvert_jusqu timestamptz,
  updated_at timestamptz default now()
);

alter table circuit_breaker enable row level security;
-- Volontairement aucune policy anon : accessible uniquement via la clé service.

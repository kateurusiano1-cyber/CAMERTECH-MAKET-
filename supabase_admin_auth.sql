-- À exécuter dans Supabase SQL Editor
-- Table utilisée uniquement par les fonctions serveur (clé service) pour la
-- nouvelle connexion admin en 2 étapes (mot de passe + code WhatsApp),
-- désormais entièrement vérifiée côté serveur. Aucun accès public.

create table if not exists admin_otp (
  ticket uuid default gen_random_uuid() primary key,
  admin_id text not null,
  code_hash text not null,
  wa text not null,
  expires_at timestamptz not null,
  used boolean not null default false,
  created_at timestamptz default now()
);

alter table admin_otp enable row level security;
-- Volontairement aucune policy anon : accessible uniquement via la clé service (serveur).

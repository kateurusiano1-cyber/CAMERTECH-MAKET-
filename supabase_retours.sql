-- À exécuter dans Supabase SQL Editor
-- Table déjà verrouillée dès sa création : plus aucun accès direct depuis
-- le navigateur n'est nécessaire, tout passe par le serveur (voir
-- api/facture.js pour la création, api/admin-action.js pour la gestion admin).

create table if not exists retours (
  id uuid default gen_random_uuid() primary key,
  reservation_id uuid references reservations(id) on delete cascade,
  utilisateur_id uuid references utilisateurs(id),
  code_commande text,
  motif text,
  statut text default 'en_attente',
  created_at timestamptz default now()
);

alter table retours enable row level security;
-- Aucune policy créée ici : verrouillée dès le départ.

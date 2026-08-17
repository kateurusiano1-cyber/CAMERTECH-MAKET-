-- À exécuter dans Supabase SQL Editor
-- Synchronisation du panier entre appareils : un client qui commence sa commande
-- sur PC et revient sur son téléphone pour payer doit retrouver son panier à jour.

create table if not exists paniers (
  utilisateur_id uuid primary key references utilisateurs(id) on delete cascade,
  items jsonb not null default '[]'::jsonb,
  zone text,
  frais_livraison integer default 0,
  updated_at timestamptz not null default now()
);

alter table paniers enable row level security;

-- Même logique d'accès que les autres tables liées à un compte client (ex: favoris) :
-- l'app utilise Firebase Auth côté client, pas l'auth Supabase, donc l'accès est
-- filtré par utilisateur_id côté application plutôt que par auth.uid() côté Supabase.
create policy "Lecture publique des paniers" on paniers for select to anon using (true);
create policy "Ecriture publique des paniers" on paniers for insert to anon with check (true);
create policy "Mise a jour publique des paniers" on paniers for update to anon using (true);
create policy "Suppression publique des paniers" on paniers for delete to anon using (true);

-- Active Supabase Realtime sur cette table : indispensable pour que l'écoute en
-- direct (ecouterPanierEnDirect côté script.js) reçoive les changements.
alter publication supabase_realtime add table paniers;

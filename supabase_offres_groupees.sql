-- À exécuter dans Supabase SQL Editor
-- "Flash Combo" / Kit Sur-Mesure : 1 produit principal (fixe) + N accessoires
-- au choix du client parmi une liste de produits éligibles (pas de doublon),
-- vendus ensemble à un prix forfaitaire fixe.
--
-- Lecture publique volontaire (comme products/bannieres) : c'est une offre
-- promotionnelle, faite pour être vue par tout le monde, y compris non
-- connecté. Aucune écriture publique : gestion uniquement via
-- api/admin-action.js (clé service role). Le PRIX appliqué à la commande
-- n'est jamais lu depuis ces tables par le client — api/preparer-paiement.js
-- revalide tout côté serveur au moment de payer (voir ce fichier).

create table if not exists offres_groupees (
  id uuid default gen_random_uuid() primary key,
  nom text not null,
  description text,
  produit_principal_id uuid references products(id) on delete cascade,
  prix_ensemble numeric not null check (prix_ensemble > 0),
  nb_choix_requis integer not null default 2 check (nb_choix_requis >= 1),
  actif boolean default true,
  date_debut timestamptz,
  date_fin timestamptz,
  created_at timestamptz default now()
);

-- Pool des produits éligibles comme accessoire "au choix" pour une offre
-- donnée (le client en choisira nb_choix_requis, distincts, parmi ceux-ci).
create table if not exists offres_groupees_choix (
  id uuid default gen_random_uuid() primary key,
  offre_id uuid references offres_groupees(id) on delete cascade,
  produit_id uuid references products(id) on delete cascade,
  unique (offre_id, produit_id)
);

alter table offres_groupees enable row level security;
alter table offres_groupees_choix enable row level security;

create policy "Lecture publique des offres groupées" on offres_groupees for select to anon using (true);
create policy "Lecture publique des choix d'offres groupées" on offres_groupees_choix for select to anon using (true);
-- Aucune policy d'écriture pour anon : verrouillé, tout passe par l'admin.

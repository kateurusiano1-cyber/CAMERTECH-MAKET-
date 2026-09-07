-- À exécuter dans Supabase SQL Editor
-- Table des codes promo. Verrouillée : AUCUNE policy anon n'est créée ici,
-- volontairement — contrairement à d'autres tables du projet (paniers,
-- favoris, retours, parametres) qui ont des policies "using(true)" trouvées
-- lors de l'audit de sécurité et encore ouvertes. Les codes promo touchent
-- directement à l'argent (réductions), donc ils ne sont accessibles QUE
-- via le serveur (clé service role) :
--   - api/preparer-paiement.js : lecture seule, pour valider un code au paiement
--   - api/admin-action.js      : lecture/écriture, pour la gestion admin

create table if not exists codes_promo (
  id uuid default gen_random_uuid() primary key,
  code text unique not null,
  type text not null check (type in ('pourcentage','montant')),
  valeur numeric not null check (valeur > 0),
  actif boolean default true,
  date_expiration timestamptz,
  usage_max integer,
  usage_actuel integer default 0,
  montant_min numeric,
  created_at timestamptz default now()
);

alter table codes_promo enable row level security;
-- Pas de "create policy" ici : par défaut, RLS activée sans aucune policy
-- = zéro accès anon, ni en lecture ni en écriture. Seule la clé service
-- role (utilisée uniquement côté serveur) peut lire/écrire cette table.

-- Incrémentation atomique du compteur d'usage — évite qu'une rafale de
-- paiements simultanés avec le même code ne dépasse usage_max à cause
-- d'un "lire puis écrire" non protégé.
create or replace function increment_promo_usage(promo_id uuid)
returns void as $$
  update codes_promo set usage_actuel = usage_actuel + 1 where id = promo_id;
$$ language sql;

-- Garde une trace du code utilisé sur chaque commande (visible en admin).
alter table reservations add column if not exists code_promo text;

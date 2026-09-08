-- À exécuter dans Supabase SQL Editor
-- Tracking analytique anonyme des visiteurs (pas connectés). Volontairement
-- SANS collecte de nom/identité réelle sans consentement : l'identifiant est
-- un UUID aléatoire généré dans le navigateur (localStorage). Si un visiteur
-- anonyme crée un compte ou passe commande plus tard, sa session se relie
-- automatiquement à son profil (utilisateur_id) — parce qu'il s'est identifié
-- lui-même à ce moment-là, pas parce qu'on est allé chercher son nom en douce.

create table if not exists visiteurs_sessions (
  session_id text primary key,
  utilisateur_id uuid references utilisateurs(id) on delete set null,
  premiere_visite timestamptz default now(),
  derniere_activite timestamptz default now(),
  nb_visites integer default 1,
  user_agent text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text
);

create table if not exists visiteurs_evenements (
  id uuid default gen_random_uuid() primary key,
  session_id text not null,
  type text not null check (type in ('page_view','produit_vu','produit_impression','panier_ajout','recherche','filtre_categorie','favori')),
  cible text,
  meta jsonb,
  duree_secondes integer,
  created_at timestamptz default now()
);
create index if not exists idx_visiteurs_evenements_session on visiteurs_evenements(session_id, created_at);

alter table visiteurs_sessions enable row level security;
alter table visiteurs_evenements enable row level security;

-- Écriture publique autorisée (le tracker tourne dans le navigateur d'un
-- visiteur non connecté, donc forcément avec la clé anon) — MAIS en
-- INSERT/UPDATE seulement, jamais en SELECT ni DELETE. Un visiteur ne peut
-- donc jamais lire ou effacer les données d'un autre visiteur (ni même les
-- siennes) directement via l'API : la lecture n'existe que côté admin, via
-- api/admin-action.js avec la clé service role.
create policy "Ecriture publique des sessions visiteurs" on visiteurs_sessions for insert to anon with check (true);
create policy "Mise a jour publique des sessions visiteurs" on visiteurs_sessions for update to anon using (true) with check (true);
create policy "Ecriture publique des evenements visiteurs" on visiteurs_evenements for insert to anon with check (true);
-- Pas de policy SELECT ni DELETE pour anon sur ces deux tables : verrouillé.

-- Nettoyage recommandé (à lancer manuellement de temps en temps, ou via une
-- tâche cron externe comme celle déjà utilisée pour la relance de panier) :
-- delete from visiteurs_evenements where created_at < now() - interval '90 days';

-- ============================================================
-- DURCISSEMENT RLS — à exécuter APRÈS avoir déployé le nouveau code
-- (api/admin-action.js, api/mon-profil.js, script.js mis à jour).
-- Si tu exécutes ce script avant le déploiement du code, le site
-- cassera (panneau admin, ajout produit, etc.) jusqu'au déploiement.
--
-- Ce script supprime les 5 policies trouvées lors de l'audit qui
-- autorisaient n'importe qui (clé publique anon) à lire ou modifier
-- des données sensibles directement via l'API Supabase, en
-- contournant totalement le site et l'authentification admin.
-- Les écritures correspondantes passent désormais uniquement par les
-- routes serveur protégées (clé service role, jamais exposée au
-- navigateur).
-- ============================================================

-- 🔴 Fuite de données : toute la table clients (nom/tél/email) était
-- lisible publiquement. Remplacée par api/mon-profil.js (client) et
-- l'action "utilisateurs / list" de api/admin-action.js (admin).
drop policy if exists "pub_utilisateurs" on utilisateurs;

-- 🔴 N'importe qui pouvait créer/modifier/supprimer des produits.
-- Remplacé par les actions "products" de api/admin-action.js.
drop policy if exists "admin_products" on products;

-- 🔴 N'importe qui pouvait créer/modifier/supprimer des bannières.
-- Remplacé par les actions "bannieres" de api/admin-action.js.
drop policy if exists "admin_bannieres" on bannières;

-- 🟠 N'importe qui pouvait valider un faux avis. Remplacé par
-- l'action "avis / update" de api/admin-action.js (aucune policy de
-- suppression n'existait avant, on garde donc ce comportement pour
-- le client public : il peut poster mais pas modifier/supprimer).
drop policy if exists "Modif avis" on avis;

-- 🟠 N'importe qui pouvait changer le statut de n'importe quelle
-- réservation. Remplacé par l'action "reservations / update" de
-- api/admin-action.js.
drop policy if exists "modif_reservation" on reservations;

-- ============================================================
-- Ce qui reste volontairement INCHANGÉ (lecture publique légitime,
-- nécessaire au fonctionnement normal du site) :
--   - pub_products (SELECT)      : catalogue visible par tous
--   - pub_bannieres (SELECT)     : bannières/promos visibles par tous
--   - Lecture avis (SELECT)      : avis visibles sur les fiches produit
--   - Ajout avis (INSERT)        : un client peut poster un avis
--   - pub_reservations (SELECT)  : suivi de commande par code
--   - ajout_reservation (INSERT) : passer une commande
--   - inscription (INSERT sur utilisateurs) : créer un compte
-- ============================================================

-- Vérification finale : ne doit plus lister que les 7 policies ci-dessus.
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('products','reservations','utilisateurs','avis','bannières')
order by tablename, cmd;

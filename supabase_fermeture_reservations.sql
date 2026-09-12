-- À exécuter dans Supabase SQL Editor
-- Ferme l'accès direct anon à `reservations`. Découvert en construisant le
-- suivi de commande invité : le "Suivi de commande" et "Mes Commandes"
-- interrogeaient directement Supabase avec la clé publique, ce qui veut
-- dire que n'importe qui pouvait potentiellement lire TOUTE la table
-- (codes, montants, téléphones, zones de livraison de tous les clients) —
-- pas juste la commande demandée. C'était le point le plus grave resté
-- ouvert depuis l'audit de sécurité initial.
--
-- Tout passe désormais par le serveur (clé service role) :
--   - api/preparer-paiement.js : création, paiement, suivi par code, liste
--     "mes commandes" (avec vérification de propriété systématique)
--   - api/admin-action.js      : lecture et changement de statut pour l'admin

drop policy if exists "pub_reservations" on reservations;
drop policy if exists "ajout_reservation" on reservations;
-- Si les noms ci-dessus ne correspondent pas exactement (créées à la main
-- dans le dashboard Supabase, jamais vues dans un fichier SQL de ce projet),
-- utilise la requête ci-dessous pour lister les vraies policies et adapte :
--   select policyname, cmd, roles from pg_policies where tablename = 'reservations';

-- Vue publique restreinte : n'expose QUE les articles achetés (pour calculer
-- les "meilleures ventes" affichées à tout le monde), jamais les noms,
-- téléphones, montants ou codes de commande. Une vue Postgres classique
-- (sans "security_invoker") s'exécute avec les droits de son créateur, donc
-- elle continue de fonctionner même si la table `reservations` elle-même
-- devient totalement fermée à la clé anon.
create or replace view meilleures_ventes as
  select items from reservations where statut in ('valide','livre');
grant select on meilleures_ventes to anon;

-- ============================================================
-- DIAGNOSTIC RLS — à exécuter tel quel dans le SQL Editor Supabase.
-- Ne modifie rien, affiche seulement l'état actuel.
-- Copie-colle le résultat (2 tableaux) pour que je puisse l'analyser.
-- ============================================================

-- 1) RLS activé ou non, table par table
select tablename,
       rowsecurity as rls_active
from pg_tables
where schemaname = 'public'
  and tablename in ('products', 'reservations', 'utilisateurs', 'avis', 'bannieres', 'bannières')
order by tablename;

-- 2) Toutes les policies existantes sur ces tables (qui a le droit de faire quoi)
select tablename,
       policyname,
       cmd as operation,       -- SELECT / INSERT / UPDATE / DELETE / ALL
       roles,
       qual as condition_lecture,
       with_check as condition_ecriture
from pg_policies
where schemaname = 'public'
  and tablename in ('products', 'reservations', 'utilisateurs', 'avis', 'bannieres', 'bannières')
order by tablename, cmd;

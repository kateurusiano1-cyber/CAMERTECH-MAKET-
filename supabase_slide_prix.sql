-- À exécuter dans Supabase SQL Editor
-- Ajoute les colonnes prix actuel/ancien pour le slide pub (bloc prix affiché
-- dans la bannière carrousel).

alter table bannières add column if not exists prix_actuel numeric;
alter table bannières add column if not exists prix_ancien numeric;

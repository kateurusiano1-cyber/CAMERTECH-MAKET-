-- À exécuter dans Supabase SQL Editor
-- Ajoute toutes les colonnes manquantes à la table "bannières"
-- (sans danger : "if not exists" n'écrase rien de ce qui existe déjà)

alter table bannières add column if not exists titre text;
alter table bannières add column if not exists tag text;
alter table bannières add column if not exists image_url text;
alter table bannières add column if not exists btn_texte text;
alter table bannières add column if not exists lien text;
alter table bannières add column if not exists produits_ids jsonb;

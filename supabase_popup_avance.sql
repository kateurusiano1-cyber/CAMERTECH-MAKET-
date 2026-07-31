-- À exécuter dans Supabase SQL Editor pour activer le popup publicitaire avancé
-- (flyer image, lien au clic, sélection manuelle de produits par l'admin)

alter table bannières add column if not exists lien text;
alter table bannières add column if not exists produits_ids jsonb;

-- Note : la colonne image_url existe normalement déjà (utilisée par le type "slider").
-- Si ce n'est pas le cas, décommente la ligne suivante :
-- alter table bannières add column if not exists image_url text;

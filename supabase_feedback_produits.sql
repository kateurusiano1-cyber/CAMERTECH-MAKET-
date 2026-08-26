-- À exécuter dans Supabase SQL Editor
-- Collecte le retour du module de personnalisation en fiche produit
-- ("Je veux en voir plus", "Trop cher", etc.) pour consultation admin.

create table if not exists feedback_produits (
  id uuid default gen_random_uuid() primary key,
  produit_id uuid,
  produit_nom text,
  categorie text,
  choix text not null,
  utilisateur_id uuid,
  created_at timestamptz default now()
);

alter table feedback_produits enable row level security;

-- Écriture publique (n'importe quel visiteur peut laisser un retour),
-- mais AUCUNE lecture publique — seul l'admin (clé service, via
-- api/admin-action.js) peut consulter les résultats.
drop policy if exists "ajout_feedback_produit" on feedback_produits;
create policy "ajout_feedback_produit" on feedback_produits
  for insert
  with check (true);

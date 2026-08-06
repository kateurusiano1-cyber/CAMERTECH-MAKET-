-- À exécuter dans Supabase SQL Editor

create table if not exists favoris (
  id uuid default gen_random_uuid() primary key,
  utilisateur_id uuid references utilisateurs(id) on delete cascade,
  product_id uuid references products(id) on delete cascade,
  created_at timestamptz default now(),
  unique(utilisateur_id, product_id)
);

alter table favoris enable row level security;
create policy "Lecture publique des favoris" on favoris for select to anon using (true);
create policy "Ecriture publique des favoris" on favoris for insert to anon with check (true);
create policy "Suppression publique des favoris" on favoris for delete to anon using (true);

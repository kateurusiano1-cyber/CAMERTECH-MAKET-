-- À exécuter dans Supabase SQL Editor

create table if not exists retours (
  id uuid default gen_random_uuid() primary key,
  reservation_id uuid references reservations(id) on delete cascade,
  utilisateur_id uuid references utilisateurs(id),
  code_commande text,
  motif text,
  statut text default 'en_attente',
  created_at timestamptz default now()
);

alter table retours enable row level security;
create policy "Lecture publique des retours" on retours for select to anon using (true);
create policy "Ecriture publique des retours" on retours for insert to anon with check (true);
create policy "Mise à jour publique des retours" on retours for update to anon using (true);

-- À exécuter dans Supabase SQL Editor
-- Table de paramètres modifiables depuis l'admin, sans toucher au code

create table if not exists parametres (
  cle text primary key,
  valeur text
);

alter table parametres enable row level security;

create policy "Lecture publique des paramètres"
  on parametres for select
  to anon
  using (true);

create policy "Ecriture publique des paramètres (admin protégé côté app)"
  on parametres for all
  to anon
  using (true)
  with check (true);

-- Valeurs de départ (reprend ce qui était en dur dans config.js)
insert into parametres (cle, valeur) values
  ('agence_adresse', 'Douala, PK14, Cameroun (adresse précise à confirmer)'),
  ('agence_tel', '237699781160')
on conflict (cle) do nothing;

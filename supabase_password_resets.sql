-- À exécuter dans Supabase SQL Editor pour activer le "mot de passe oublié"

create table if not exists password_resets (
  id uuid default gen_random_uuid() primary key,
  utilisateur_id uuid references utilisateurs(id) on delete cascade,
  contact text not null,
  methode text not null,          -- 'whatsapp' | 'email' | 'sms'
  code text not null,
  expire_at timestamptz not null,
  utilise boolean default false,
  created_at timestamptz default now()
);

-- Autoriser les lectures/écritures depuis le frontend (clé anonyme) sur cette table
alter table password_resets enable row level security;

create policy "Insertion publique des demandes de reset"
  on password_resets for insert
  to anon
  with check (true);

create policy "Lecture publique pour vérification du code"
  on password_resets for select
  to anon
  using (true);

create policy "Mise à jour publique (marquer comme utilisé)"
  on password_resets for update
  to anon
  using (true);

-- À exécuter dans Supabase SQL Editor
-- Programme de fidélité : 1 point tous les 1 000 FCFA dépensés, attribué
-- automatiquement dès qu'une commande passe à "valide" ou "livre". Le calcul
-- se fait par un trigger côté base de données (pas dans le code du site) —
-- impossible à contourner en trafiquant une requête depuis le navigateur.

alter table utilisateurs add column if not exists points integer not null default 0;

create or replace function attribuer_points_fidelite()
returns trigger as $$
begin
  if new.statut in ('valide','livre')
     and (old.statut is distinct from new.statut)
     and old.statut not in ('valide','livre')
     and new.utilisateur_id is not null then
    update utilisateurs
    set points = points + floor(new.total / 1000)
    where id = new.utilisateur_id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_points_fidelite on reservations;
create trigger trg_points_fidelite
after update on reservations
for each row execute function attribuer_points_fidelite();

-- À exécuter dans Supabase SQL Editor
-- Suite du durcissement RLS (audit de sécurité) : ferme les policies grandes
-- ouvertes sur parametres et retours, maintenant que tous leurs accès
-- passent par le serveur (api/admin-action.js et api/facture.js).

-- parametres : la LECTURE reste publique volontairement (adresse/téléphone
-- de l'agence, images de catégories — c'est du contenu de vitrine, pas des
-- données sensibles). Seule l'ÉCRITURE publique est retirée.
drop policy if exists "Ecriture publique des parametres (admin protégé côté app)" on parametres;

-- retours : plus aucun accès direct depuis le navigateur, ni en lecture, ni
-- en écriture, ni en mise à jour — tout passe désormais par le serveur.
drop policy if exists "Lecture publique des retours" on retours;
drop policy if exists "Ecriture publique des retours" on retours;
drop policy if exists "Mise à jour publique des retours" on retours;

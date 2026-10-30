# Plan gratuit Supabase : limites et mesures prises

Limites relevées le 30 octobre 2026 sur supabase.com (page des tarifs et documentation). Mesures du projet
`avhqhvedgppuieellruz` le même jour (158 tickets depuis 2022, 84 recettes, 7 illustrations).

| Limite du plan gratuit | Usage mesuré ou prévu | Mesures dans le programme |
|---|---|---|
| Base de données : 500 Mo (lecture seule au-delà) | 18 Mo, dont 1 Mo de tickets bruts ; ≈ +3 Mo par an (≈ 100 tickets) | Données sobres (montants en centimes, lignes de tickets), journal Mistral `ai_calls` purgé après 90 jours |
| Fichiers : 1 Go | 2,7 Mo (7 images de ≈ 390 Ko) ; ≈ 33 Mo une fois les 84 recettes illustrées | Une image par recette (commune au foyer), photos du foyer réduites à 1 024 px en JPEG (≈ 200 Ko) avant envoi, fichier limité à 5 Mo |
| Sortie réseau : 5 Go non caché + 5 Go caché par mois | Images ≈ 33 Mo par téléphone, téléchargées une seule fois ; requêtes ≈ quelques Mo par mois | Images créées par Mistral servies par lien public stable (seau `recipe-images`, mis en cache par le CDN : sortie « en cache ») et téléchargées en avance une seule fois par téléphone ; photos du foyer dans le seau privé `household-photos` (liens de 7 jours) ; requêtes limitées aux colonnes utiles |
| Fonctions : 500 000 appels par mois, 150 s par appel, 2 s de calcul, 256 Mo | Quelques dizaines d'appels par mois (idées, imports, illustrations) | 40 appels par heure et par foyer au plus ; appels à Mistral coupés à 100 s, téléchargement d'image à 30 s ; aucun calcul lourd dans la fonction (pas de retouche d'image) |
| Utilisateurs actifs : 50 000 par mois | 1 compte partagé | — |
| Projets actifs : 2 | 1 | — |
| Mise en pause après 7 jours d'inactivité (restauration possible pendant 90 jours) | Risque pendant les vacances | Usage normal de l'application, et tâche quotidienne `.github/workflows/supabase-activite.yml` qui appelle la fonction `ping` (aucune donnée lue). Elle ne s'exécute que depuis la branche par défaut du dépôt. |
| Transformations d'images : non incluses | Non utilisées | Réduction des photos faite sur le téléphone (`expo-image-manipulator`) |
| Taille maximale d'un fichier : 50 Mo | Images de 0,2 à 0,5 Mo | Seau `recipe-images` limité à 5 Mo et aux formats PNG, JPEG, WebP |
| Temps réel : 200 connexions, 2 millions de messages | Non utilisé | — |

## Quota Mistral (offre gratuite, indépendant de Supabase)

- Texte : Mistral Small et Medium bloqués ; Ministral 14B utilisé.
- Images : 7 images ont été créées avant que Mistral ne refuse (code 429). Après un refus, la fonction met la création
  d'images en pause 6 heures (`app_settings.mistral_image_pause_until`) et répond aussitôt sans appeler Mistral.
  L'application crée ensuite les images manquantes au fil de l'usage, une à la fois, pour la carte affichée ;
  en attendant, un dessin d'après les ingrédients s'affiche.

## Surveiller l'usage

Tableau de bord Supabase : Organisation › Usage. Requêtes utiles (éditeur SQL) :

```sql
select pg_size_pretty(pg_database_size(current_database()));                 -- base de données (limite 500 Mo)
select count(*), pg_size_pretty(sum((metadata->>'size')::bigint))             -- fichiers (limite 1 Go)
from storage.objects;
select action, ok, count(*) from public.ai_calls                              -- appels à Mistral, 30 derniers jours
where created_at > now() - interval '30 days' group by 1, 2;
```

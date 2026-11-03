# Capacité : projection à 500 recettes

Mesures du 3 novembre 2026 sur le projet Supabase (plan gratuit), avec 147 recettes (239 versions, 2 187 lignes
d'ingrédients, 145 photos de plats), puis projection à 500 recettes.

## Plan gratuit Supabase

| Quota (plan gratuit) | Aujourd'hui | Projection à 500 recettes | Part du quota |
|---|---|---|---|
| Base de données : 500 Mo par projet | 25 Mo (dont ≈ 2 Mo de recettes, index compris) | ≈ 33 Mo | ≈ 7 % |
| Stockage de fichiers : 1 Go | 19 Mo (photos des plats : 17,2 Mo, soit ≈ 118 Ko par plat ; vignettes d'ingrédients : 1,9 Mo) | ≈ 65 Mo | ≈ 7 % |
| Sortie réseau : 5 Go par mois (+ 5 Go servis par le cache) | non mesurée ici (tableau de bord Supabase, page Usage) | ≈ 0,4 Go par mois pour 4 téléphones, plus ≈ 40 Mo une seule fois par téléphone pour les photos non embarquées | < 10 % |
| Appels de fonctions : 500 000 par mois | sans rapport avec le nombre de recettes | inchangé | — |

- **Base** : une recette avec ses versions et ses ingrédients occupe ≈ 14 Ko. 500 recettes, même avec une adaptation sur
  deux, restent sous 10 Mo de données de recettes. La base grossit surtout avec les tickets Lidl (≈ 2 Mo pour 158
  tickets), sans rapport avec les recettes. Le schéma de sauvegarde des tests (`sauvegarde_test`, 1,5 Mo) peut être
  supprimé.
- **Rapidité** : la requête la plus lourde (catalogue complet avec le piquant et tous les ingrédients) a été mesurée sur
  584 recettes simulées : **66 ms** côté base. Toutes les jointures utilisent un index (ingrédients par version, versions
  par recette, images par recette).
- **Données lues par le téléphone à 500 recettes** : catalogue ≈ 300 Ko, ingrédients de toutes les recettes (moteur de
  menus, gardés en mémoire pendant la session) ≈ 1,2 Mo, liste des images ≈ 100 Ko, avant compression.

## Limites de l'application corrigées (version 0.26.0)

Supabase renvoie au plus **1 000 lignes par requête**. Le moteur de menus lisait déjà tout par pages ; deux lectures ne
le faisaient pas :

- **Onglet Recettes** : il ne lisait que les 300 premières recettes par ordre alphabétique. À 500 recettes, les plats de
  la fin de l'alphabet (« S » à « Z ») auraient disparu de la liste. Il lit maintenant tout le catalogue, par pages.
- **Liste des images** : lue en une seule requête, elle aurait perdu des images au-delà de 1 000 lignes (images communes
  et photos du foyer). Elle est maintenant lue par pages.
- **Affichage de l'onglet Recettes** : les cartes étaient toutes dessinées d'un coup. À 500 recettes, cela aurait fait
  500 photos décodées en mémoire (≈ 90 Mo) et une ouverture lente. La liste est maintenant virtualisée : seules les
  cartes visibles et quelques-unes autour sont dessinées (36 sur 146 à l'ouverture dans l'aperçu web).

## Limites restantes, sans effet avant 1 000 lignes

- Fonctions d'entretien des images (`illustrate_missing`, `dish_photos`) : la liste des images y est lue en une requête
  (≈ 500 lignes à 500 recettes).
- Réduction des anciennes images de 1 024 px (`shrink_images`) : ne parcourt que 200 fichiers ; les nouvelles images
  sont déjà enregistrées en petit format.
- Référentiel des ingrédients (choix proposés à la correction d'un produit) : 217 ingrédients, lus en une requête.

## Poids de l'application

Les photos des plats sont embarquées dans l'APK pour s'afficher sans attendre le réseau : ≈ 49 Ko par plat (grande
photo et miniature en WebP). À 500 plats, cela ajouterait ≈ 17 Mo (≈ 45 Mo pour l'APK 64 bits au lieu de 28 Mo). Si ce
poids gêne, il suffira de n'embarquer que les miniatures (≈ 10 Ko par plat) : les grandes photos seraient alors
téléchargées une fois par téléphone à la première ouverture de la fiche.

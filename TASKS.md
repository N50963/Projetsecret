# Suivi des tâches

| Phase | Statut | Notes |
|---|---|---|
| 1. Audit du connecteur Lidl Plus | **Largement fait** | Prototype réel réussi (voir `docs/phase1-resultats-prototype.md`). Reste à mesurer : durée de vie du token, appel depuis un téléphone. |
| 2. Fondations | **Fait** | Supabase (schéma, RLS), application Expo SDK 58 (`app/`, `docs/application-mobile.md`) : compte partagé, foyer, navigation. |
| 3. Référentiel produits et recettes | **Fait** | 216 ingrédients (allergènes, niveau d'épice), 270 règles, contenances (ticket + Open Food Facts) ; base de 84 recettes versionnées (`docs/base-recettes.md`). |
| 4. Synchronisation des tickets | **Fait, à essayer sur téléphone** | Connexion Lidl dans l'application (page Lidl, PKCE, stockage sécurisé), récupération et import des tickets. Reste : essai réel sur les deux téléphones. |
| 5. Stocks | Estimation | Stock estimé d'après les tickets, les durées de conservation et les repas choisis (moteur de menus). Pas d'inventaire manuel. |
| 6. Mistral et recettes | **Fait** | Fonction serveur `mistral` : import de recettes, idées selon les notes et l'équilibre, adaptation d'après un avis, illustrations (images Mistral). Ministral 14B avec la clé gratuite. |
| 7. Planification | **Fait** | Choix des repas et du temps, propositions à swiper (courses, puis 1 à 3 achats, puis Mistral), équilibre et variété (`app/src/modules/planning`). |
| 8. Préférences et équilibre | **Fait** | `household_preferences` (2 adultes, 1 ado, 1 enfant ; ni abats ni coquillages ; curry et chorizo doux, rien de piquant ; 1 à 2 soirs sans viande), appliquées par le moteur et par Mistral ; écran Préférences. |
| 9. Liste de courses | **Fait** | Ingrédients manquants des repas choisis, cochés automatiquement quand ils apparaissent sur un ticket. |
| 10. Finalisation | En cours | Projet Android natif (`app/android`) compilable en APK dans Android Studio (`docs/android-apk.md`) ; compte du foyer créé, connexion seule dans l'application. Reste : essai sur téléphone, illustrations de toutes les recettes. |

## À traiter ensuite
- Essayer sur un vrai téléphone : connexion Lidl dans l'application, récupération des tickets, swipe.
- Produits « à confirmer » restants (vue `products_to_confirm`) : anciens achats sans intérêt pour les menus (boisson, panier anti-gaspillage, 2022-2023).
- Groupes d'aliments exclus (abats, coquillages) : reconnus par les slugs des ingrédients ; le référentiel n'en contient pas encore.
- Migration `20261029000003` : la seconde passe de suppression par mots-clés a été appliquée directement, voir le commentaire du fichier.
- Formats de produits : 49 confirmés par le foyer (20 % des achats d'ingrédients, dont pain et gnocchis) ; restent 7 % de formats incertains (124 produits peu achetés) et 9,5 % sans contenance connue (219 produits peu achetés).

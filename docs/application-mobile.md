# Application mobile « MenuMalin »

Charte graphique : canevas Claude Design « MenuMalin » (claude.ai, artboards Accueil, Fiche recette, Propositions,
Courses, Paramètres, Connexion, états et planche de composants), reproduit au plus près :

- couleurs (`app/src/lib/theme.ts`) : fond crème #FEF3E3, cartes #FDF4E9, vert #2C5A27, vert doux #E7E3BE, texte
  orange #8A4B12 pour « à acheter », bande verte #445A33 en tête des écrans ;
- typographie : Roboto (police du système Android), nom « MenuMalin » en Cabin gras italique
  (`app/assets/fonts`, licence OFL) ;
- logo en feuilles et icônes : tracés SVG des maquettes (`app/src/components/icons.tsx`, react-native-svg) ;
- boutons pleine largeur à dégradé vert, puces beiges (vert doux bordé de vert quand elles sont choisies),
  barre du bas Accueil · Courses · Profil.

Code : `app/` (Expo SDK 58, Expo Router, TypeScript). Données : Supabase (projet `avhqhvedgppuieellruz`).
Fonction serveur Mistral : `supabase/functions/mistral/index.ts` (la clé Mistral reste dans les secrets Supabase).

## Déroulé

1. **Connexion** au compte partagé du foyer (mêmes identifiants sur les deux téléphones), puis code du foyer
   la première fois.
2. **Tickets Lidl Plus** : la page de connexion officielle de Lidl s'ouvre dans l'application ; la personne s'y connecte
   elle-même. Le jeton obtenu reste dans le stockage sécurisé du téléphone (Keychain / Keystore) et n'est jamais envoyé
   à Supabase. Chaque téléphone se connecte une fois. Les tickets sont ensuite lus directement chez Lidl par le
   téléphone, puis enregistrés dans Supabase.
3. **Comparaison avec la liste de courses** : un article est coché tout seul quand son ingrédient apparaît sur un ticket
   postérieur à son ajout (vue `shopping_list_status`).
4. **Accueil** : en grand, le menu du jour (ou, s'il n'y en a pas, le prochain menu de la semaine) ; puis les menus de
   la semaine empilés en lignes (photo qui part du bord gauche et s'efface en fondu avant le nom, jour écrit en entier ;
   un toucher ouvre la recette en fondu). Les repas à prévoir (déjeuners et dîners à cocher, temps disponible :
   30 min, 1 h ou sans limite) sont masqués dès que des menus sont choisis, derrière le raccourci « Prévoir d'autres
   repas ».
5. **Propositions** (moteur `app/src/modules/planning`) : pour chaque repas, 3 recettes réalisables avec les courses,
   classées selon l'équilibre et la variété de la semaine. Swipe à droite pour choisir, à gauche pour passer (ou
   boutons). Si aucune ne convient : 3 recettes avec 1 à 3 ingrédients à acheter, puis 3 idées créées par Mistral.
   Les ingrédients manquants des recettes choisies vont sur la liste de courses.
6. **Fiches recettes** : photo du plat (« Plus d'options » › Photo du plat : appareil photo ou galerie ; la photo du foyer remplace
   l'image créée par Mistral, qui ne l'écrase jamais), quantités pour le nombre de personnes, étapes « pas à pas »
   avec un seul minuteur par étape ; la recette faite, « Bon appétit ! » propose de mettre sa propre photo du plat. Chaque minuteur dit ce qu'il minute (« Cuire le riz », étape 6) : on s'y retrouve
   quand plusieurs tournent. Avis sur 5 étoiles avec un commentaire facultatif (4-5 étoiles comptent comme « aimé »,
   3 comme « bof », 1-2 comme « pas aimé » pour le choix des menus). Le commentaire peut servir à faire adapter la
   recette par Mistral ; la version proposée s'ouvre dans un éditeur (nom, temps, ingrédients, étapes) et c'est
   l'utilisateur qui décide : il la corrige puis la garde, ou garde la recette actuelle.
7. **Ajout de recettes** : texte collé ou saisie libre, mis en forme par Mistral (durées de cuisson, feu et
   température précisés : chaque étape avec une durée aura son minuteur). L'utilisateur relit et corrige tout dans
   l'éditeur avant d'enregistrer ; photo du plat facultative (appareil photo ou galerie), sinon Mistral crée une
   illustration.
8. **Favoris** : cœur dans la bande verte de la fiche ; filtre « Favoris » dans la liste des recettes. « Ajouter à ma
   liste » met sur la liste de courses les ingrédients ni de placard ni achetés ces 7 derniers jours.

Hors champ : petits-déjeuners, entrées, desserts, plateaux de fromages (seuls les plats principaux sont proposés).

## Équilibre et variété (moteur de menus)

Repères pour 7 repas, ramenés au nombre de repas prévus : poisson 2 fois, viande rouge 2 fois au plus, volaille 3 fois
au plus, légumineuses au moins une fois, 1 à 2 soirs sans viande ni poisson (préférences du foyer), des légumes à chaque
repas ; pas la même protéine, le même féculent ou la même cuisine deux jours de suite ; une recette servie n'est pas
reproposée avant 21 jours. Les produits frais sont utilisés avant leur fin de conservation (poisson 2 jours, viande 3,
légumes 7…) ; un repas choisi réserve ses ingrédients. Les recettes aimées remontent, celles qui déplaisent disparaissent.

## Mistral (offre gratuite)

- Texte : Mistral Small et Medium sont bloqués par l'offre gratuite de la clé ; la fonction utilise Ministral 14B
  (repli sur Ministral 8B). Les recettes renvoyées sont des brouillons, vérifiés (`validateRecipe`) avant enregistrement.
- Images : génération d'images Mistral (agent avec l'outil `image_generation`), ≈ 15 s par image, enregistrée dans le
  stockage Supabase (`recipe-images`). L'offre gratuite n'en a accepté que 7 avant de refuser : la fonction se met alors
  en pause 6 heures et l'application crée les images manquantes au fil de l'usage. Sans image, un dessin d'après les
  ingrédients s'affiche ; une photo prise par le foyer remplace l'image.
- Limite : 40 appels par heure et par foyer (journal `ai_calls`).
- Plan gratuit Supabase : voir `docs/plan-gratuit-supabase.md`.

## Installer l'application sur les téléphones

**APK Android** (application installée, sans ordinateur allumé) : compilation dans Android Studio, voir
`docs/android-apk.md`.

**Pour le développement** : Node.js 22 et l'application **Expo Go** sur le téléphone.

```bash
git pull
cd app
npm install
npx expo start          # même réseau Wi-Fi que le téléphone ; scanner le QR code avec Expo Go
```

### Première ouverture

1. Se connecter avec l'e-mail et le mot de passe du compte du foyer. Ce compte est créé à l'avance (l'application ne
   permet pas d'en créer) et déjà relié au foyer « Mon foyer » et à ses tickets ; le mot de passe se change dans
   **Préférences › Compte**. Un autre compte devrait saisir le code du foyer après sa première connexion.
2. « Connecter Lidl Plus » et se connecter sur la page Lidl ; puis « Récupérer les nouveaux tickets ».
3. Sur le second téléphone : se connecter avec les mêmes identifiants, puis « Connecter Lidl Plus ».

## Vérifications faites (29 octobre 2026)

- Vérification des types, 62 tests TypeScript (dont moteur sur les achats réels, parité des tickets, connexion Lidl)
  et 42 tests Python.
- Paquets Android (Hermes) et web compilés ; `expo-doctor` : 20 contrôles sur 20.
- Parcours réel dans l'aperçu web avec un compte de test temporaire : connexion, choix des repas, propositions,
  refus puis choix, repas suivant, fiche recette ; aucune erreur. Compte et données de test supprimés ensuite.
- Fonction Mistral : clé valide, génération de recettes (Ministral 14B), création d'image (photo du poulet basquaise,
  1024 × 768), accès refusé sans compte ou hors du foyer.

## Limites connues

- La connexion Lidl dans l'application et la récupération des tickets depuis un téléphone n'ont pas encore été essayées
  sur un vrai téléphone (le même échange a été validé depuis l'ordinateur).
- Les recettes générées par un petit modèle sont parfois approximatives (étapes, portions) : elles sont montrées avant
  d'être enregistrées et peuvent être adaptées ensuite.
- Le stock est estimé d'après les tickets et les repas choisis dans l'application (pas d'inventaire).

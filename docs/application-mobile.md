# Application mobile « Menus du foyer »

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
4. **Repas de la semaine** : choix des déjeuners et dîners à prévoir et du temps disponible (préparation + cuisson),
   jour par jour.
5. **Propositions** (moteur `app/src/modules/planning`) : pour chaque repas, 3 recettes réalisables avec les courses,
   classées selon l'équilibre et la variété de la semaine. Swipe à droite pour choisir, à gauche pour passer (ou
   boutons). Si aucune ne convient : 3 recettes avec 1 à 3 ingrédients à acheter, puis 3 idées créées par Mistral.
   Les ingrédients manquants des recettes choisies vont sur la liste de courses.
6. **Fiches recettes** : illustration, quantités pour le nombre de personnes, étapes, avis commun (j'aime / bof /
   pas aimé), adaptation par Mistral (« moins de crème », « sans champignons »…), photo du plat.
7. **Ajout de recettes** : texte collé ou saisie libre, mis en forme par Mistral, vérifié avant enregistrement.

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

## Lancer l'application sur les téléphones

Prérequis sur un ordinateur : Node.js 22 et le dépôt à jour (branche `ccr-dfe53054-07n16j`). Sur chaque téléphone :
l'application **Expo Go** (App Store / Play Store).

```bash
git pull
cd app
npm install
npx expo start          # même réseau Wi-Fi que les téléphones
# ou : npx expo start --tunnel   si les téléphones ne sont pas sur le même réseau
```

Scanner le QR code affiché : avec Expo Go sur Android, avec l'appareil photo sur iPhone.

Pour une application installée sans ordinateur allumé (fichier APK Android ou TestFlight iOS) : compilation avec EAS
(`npx eas-cli@latest build`), qui nécessite un compte Expo (gratuit).

### Première ouverture

1. « Créer le compte du foyer » (e-mail + mot de passe d'au moins 8 caractères), puis valider l'e-mail de confirmation
   envoyé par Supabase (la page ouverte par le lien peut ne pas s'afficher : le compte est quand même confirmé).
2. Se connecter, puis saisir le code du foyer (donné à part, il relie le compte aux tickets déjà importés).
3. « Connecter Lidl Plus » et se connecter sur la page Lidl ; puis « Récupérer les nouveaux tickets ».
4. Sur le second téléphone : se connecter avec les mêmes identifiants, puis « Connecter Lidl Plus ».

## Vérifications faites (29 octobre 2026)

- Vérification des types, 62 tests TypeScript (dont moteur sur les achats réels, parité des tickets, connexion Lidl)
  et 42 tests Python.
- Paquets Android (Hermes) et web compilés ; `expo-doctor` : 20 contrôles sur 20.
- Parcours réel dans l'aperçu web avec un compte de test temporaire : connexion, choix des repas, propositions,
  refus puis choix, repas suivant, fiche recette ; aucune erreur.
- Fonction Mistral : clé valide, génération de recettes (Ministral 14B), création d'image (photo du poulet basquaise,
  1024 × 768), accès refusé sans compte ou hors du foyer.

## Limites connues

- La connexion Lidl dans l'application et la récupération des tickets depuis un téléphone n'ont pas encore été essayées
  sur un vrai téléphone (le même échange a été validé depuis l'ordinateur).
- Les recettes générées par un petit modèle sont parfois approximatives (étapes, portions) : elles sont montrées avant
  d'être enregistrées et peuvent être adaptées ensuite.
- Le stock est estimé d'après les tickets et les repas choisis dans l'application (pas d'inventaire).

# Application mobile « MenuBily »

Charte graphique : canevas Claude Design « MenuMalin » (ancien nom de l'application) (claude.ai, artboards Accueil, Fiche recette, Propositions,
Courses, Paramètres, Connexion, états et planche de composants), reproduit au plus près :

- couleurs (`app/src/lib/theme.ts`) : fond crème #FEF3E3, cartes #FDF4E9, vert #2C5A27, vert doux #E7E3BE, texte
  orange #8A4B12 pour « à acheter », bande verte #445A33 en tête des écrans ;
- typographie : Roboto (police du système Android), nom « MenuBily » en Cabin gras italique
  (`app/assets/fonts`, licence OFL) ;
- logo et icône de l'application : la marmite (`app/assets/marmite-source.png`), déclinée par
  `app/scripts/icone-marmite.py` (icônes Android, écran de démarrage, `assets/logo-marmite.png`) ; icônes de l'interface :
  tracés SVG des maquettes (`app/src/components/icons.tsx`, react-native-svg) ;
- boutons pleine largeur à dégradé vert, puces beiges (vert doux bordé de vert quand elles sont choisies),
  barre du bas Accueil · Courses · Recettes · Profil.

Code : `app/` (Expo SDK 58, Expo Router, TypeScript). Données : Supabase (projet `avhqhvedgppuieellruz`).
Fonction serveur Mistral : `supabase/functions/mistral/index.ts` (la clé Mistral reste dans les secrets Supabase).

## Déroulé

1. **Connexion** au compte partagé du foyer (mêmes identifiants sur les deux téléphones), puis code du foyer
   la première fois.
2. **Tickets Lidl Plus** : la page de connexion officielle de Lidl s'ouvre dans l'application ; la personne s'y connecte
   elle-même. Le jeton obtenu reste dans le stockage sécurisé du téléphone (Keychain / Keystore) et n'est jamais envoyé
   à Supabase. Chaque téléphone se connecte une fois. Les tickets sont ensuite lus directement chez Lidl par le
   téléphone, puis enregistrés dans Supabase.
3. **Correction des produits** (module ouvert après la récupération des tickets, ou Profil › Vérifier / Corriger un
   produit) : chaque nouveau produit Lidl apparaît avec ce que MenuBily en a compris (rôle et ingrédients), les non
   reconnus d'abord, lus par Mistral qui propose un nom, un rôle et les ingrédients. Le foyer valide (« C'est juste »,
   « Tout valider ») ou corrige : nom, rôle (ingrédient, plat tout prêt, dessert, grignotage, petit-déjeuner, boisson,
   pain, non alimentaire) et ingrédients du référentiel. Une correction vaut pour tous les achats du produit, passés et
   futurs (stock et menus), et prime sur les règles ; un produit non alimentaire est ensuite ignoré. La recherche permet
   de corriger n'importe quel produit déjà acheté (ex. « pavés de truite » → truite fumée).
4. **Comparaison avec la liste de courses** : un article est coché tout seul quand son ingrédient apparaît sur un ticket
   postérieur à son ajout (vue `shopping_list_status`).
5. **Accueil** : en grand, bord à bord avec un fondu à droite, le prochain repas (menu du jour ou, s'il n'y en a pas, le
   prochain menu de la semaine ; après 15 h, le déjeuner du jour laisse la place au dîner ; croix pour l'annuler,
   toucher pour la fiche). Les autres menus choisis se retrouvent jour
   par jour dans le ruban de la semaine (plus de liste séparée, pas de titre de section). Le ruban
   reprend la maquette Claude Design « Ruban de la semaine » (`components/WeekRibbon.tsx`) : les 7 jours en pastilles
   (jour abrégé, numéro, deux barrettes pour le déjeuner et le dîner : vert = menu choisi, vert clair = à proposer,
   beige = libre), puis la carte du jour touché. Un menu choisi y apparaît avec sa photo (toucher : fiche ; croix :
   annuler) ; un repas libre se coche (« À proposer ») et reçoit son temps disponible (30 min, 1 h ou sans limite).
   Il est toujours affiché ; « Proposer les menus (n repas) » lance les propositions. Les repas du jour passés ne sont
   plus à prévoir : le déjeuner après 14 h, le dîner après 20 h (ils disparaissent de la carte du jour, du décompte et du
   menu du jour par ingrédient). Une fois la semaine choisie (des menus choisis, plus rien à proposer), les repas à
   prévoir sont repliés : la carte d'un jour ne montre que ses menus, le bouton des propositions disparaît, et un lien
   discret « Prévoir un autre repas » rouvre les repas à cocher (rien n'est alors coché d'avance ; ils se replient de
   nouveau au retour sur l'accueil s'ils n'ont pas été cochés). Semaine encore vide : le dîner de chaque jour est coché
   d'avance. La liste de courses n'a plus de carte sur l'accueil : une pastille rouge sur l'onglet Courses de la barre du
   bas donne le nombre d'articles à acheter (mis à jour par l'accueil, la liste et la fiche recette). Un menu choisi se déplace en
   faisant glisser sa poignée (six points, à droite de la ligne : le menu se détache dès que le doigt bouge) ou par appui
   long sur le menu (250 ms, le téléphone vibre quand il se détache) ; glisser tout de suite ailleurs sur la ligne fait
   défiler la page, un toucher bref ouvre la fiche. Le menu détaché suit le doigt, au-dessus du pouce. On le dépose sur
   une pastille de jour (même repas de ce jour, à quelques points près ; survolée un instant, la pastille ouvre son jour)
   ou sur l'autre repas de la carte (« Déposer le menu ici ») ; un menu déjà prévu à cet endroit échange sa place avec
   lui (fonction SQL `move_meal_choice`, les articles de courses suivent leur menu). Gestes natifs
   (react-native-gesture-handler, défilement de l'accueil compris) : une fois le menu détaché, la page ne reprend plus le
   geste (avec le système de gestes de React Native, Android reprenait le doigt pour faire défiler et le menu retombait) ;
   la carte du jour de départ reste montée, invisible, quand un autre jour s'ouvre (le menu retombait aussi à ce moment).
6. **Menu du jour avec un ingrédient** (carte principale de l'accueil) : le foyer tape un ingrédient (recherche parmi
   les ingrédients des recettes, sans suggestion avant la saisie), s'il l'a acheté ou va
   l'acheter, le repas (déjeuner ou dîner) et le temps disponible. Les propositions suivent les mêmes règles que les
   menus de la semaine (swipe, recettes avec les courses, puis avec 1 à 3 achats, puis idées de Mistral autour de
   l'ingrédient), limitées aux recettes qui l'utilisent. Le menu du jour puise d'abord dans ce qui est à la maison,
   même ce qui était compté pour un repas prévu plus tard ; un ingrédient « à acheter » rejoint la liste de courses.
   Une fois le menu choisi, si un repas prévu plus tard n'a plus assez d'un ingrédient, l'application le signale :
   « Proposer un autre repas » (nouvelles propositions selon ce qui reste et ce qui est prévu) ou « Le garder »
   (les manques vont sur la liste de courses). La fiche du menu du jour s'ouvre ensuite, avec ses étapes.
7. **Propositions** (moteur `app/src/modules/planning`) : pour chaque repas, d'abord jusqu'à 5 recettes réalisables
   avec les courses, celles qui équilibrent et varient la semaine en tête. Swipe à droite pour choisir, à gauche pour
   passer (ou boutons). Si aucune ne convient : 3 recettes avec 1 à 3 ingrédients à acheter, puis 3 idées créées par
   Mistral, préparées en arrière-plan dès que le foyer cherche encore (un refus parmi les recettes à acheter, la dernière
   proposition, ou plus rien à proposer) : lancées dès l'arrivée des recettes à acheter, elles partaient pour presque
   chaque repas et étaient perdues au premier choix (trois demandes à Mistral pour rien). « Repas 1 sur 2 » ne compte que
   les repas demandés à l'ouverture. Le choix d'un menu s'enregistre en arrière-plan : le repas suivant s'affiche
   aussitôt (seul ce repas est calculé, la carte part par une animation native). À l'ouverture, toutes les données du
   moteur sont lues en même temps, et les ingrédients des recettes restent en mémoire pendant la session (une version de
   recette ne change jamais) : la recherche par ingrédient de l'accueil les charge, les propositions s'ouvrent ensuite
   sans les relire (5,9 s → 2,4 s mesurées depuis un serveur éloigné de Supabase).
   Les ingrédients manquants des recettes choisies vont sur la liste de courses.
8. **Fiches recettes** : photo du plat (« Plus d'options » › Photo du plat : appareil photo ou galerie ; la photo prise
   avec le téléphone remplace l'image créée par Mistral, qui ne l'écrase jamais), temps de préparation, de cuisson et
   total en haut de la fiche (photo libre de Commons, image créée par Mistral ou visuel fourni par le foyer : 33 plats,
   fichiers de data/photos-plats copiés en ligne par la fonction foyer-photos ; miniatures de 240 px embarquées pour les
   listes et le ruban, image embarquée affichée pendant le téléchargement d'une image plus récente), ingrédients avec leur vignette (photo libre de droits de Wikimedia Commons, crédits dans
   Profil › Crédits des photos), quantités pour le nombre de personnes, étapes « pas à pas » avec un seul minuteur par
   étape. Chaque minuteur dit ce qu'il minute (« Cuire le riz », étape 6) : on s'y retrouve quand plusieurs tournent ;
   « C'est prêt » reste grisé tant qu'un minuteur tourne.
9. **Note et remarque** : une seule barre de notation, en haut de la fiche (5 étoiles, modifiables à tout moment ; la
   note touchée s'affiche aussitôt, pendant son enregistrement).
   La note pondère toujours les propositions (4-5 comptent comme « aimé », 3 comme « bof », 1-2 comme « pas aimé ») et
   ne sollicite pas Mistral. Le jour où la recette est faite, une remarque sur le contenu (goût, quantités, cuisson)
   peut être envoyée : Mistral la lit et dit si la recette est améliorable ; si oui, la version proposée s'ouvre dans
   l'éditeur (nom, temps, ingrédients, étapes) et c'est l'utilisateur qui décide : il la corrige puis la garde, ou garde
   la recette actuelle (le résumé des changements, coupé à 300 caractères par la fonction, est ramené à des phrases
   entières). Pas de demande de modification à Mistral sans remarque. « Bon appétit ! » propose aussi de mettre sa propre photo du plat.
10. **Recettes** (onglet de la barre du bas) : recherche (lancée quand la saisie marque une pause ; une réponse plus
   ancienne n'écrase jamais les résultats), filtre Favoris, filtre par note (5 étoiles, 4 et +, 3 et +,
   non notées), note affichée sur chaque ligne. Les recettes ajoutées par le foyer se modifient ou se suppriment depuis
   leur fiche (« Plus d'options » › Modifier / Supprimer) ; les recettes de la base commune ne sont pas modifiables.
11. **Ajout de recettes** : texte collé ou saisie libre, mis en forme par Mistral (durées de cuisson, feu et
   température précisés : chaque étape avec une durée aura son minuteur). L'utilisateur relit et corrige tout dans
   l'éditeur avant d'enregistrer ; photo du plat facultative (appareil photo ou galerie), sinon Mistral crée une
   illustration.
12. **Favoris** : cœur dans la bande verte de la fiche ; filtre « Favoris » dans l'onglet Recettes. « Ajouter à ma
   liste » met sur la liste de courses les ingrédients marqués « à acheter » (ni de placard, ni encore à la maison selon
   le stock estimé des propositions). Quand tout est normalement à la maison, le bouton devient « Je n'en ai plus,
   j'ajoute à ma liste » : les ingrédients concernés se cochent (tous au départ) et rejoignent la liste, car le foyer a
   pu les consommer en dehors des menus prévus (fonction SQL `recipe_shopping_status`). Chaque ingrédient acheté a aussi
   son propre panier « Je n'en ai plus » au bout de sa ligne : un toucher l'ajoute seul à la liste, même quand d'autres
   ingrédients sont à acheter.
   **Liste de courses** : chaque ligne se retire d'un toucher sur sa croix (pas besoin de l'acheter) ; un bandeau
   « Annuler » la remet aussitôt en cas d'erreur. L'article n'est pas effacé (colonne `removed_at`) : sur la fiche de la
   recette, l'ingrédient porte une petite mention « Retiré de votre liste » avec un lien « Remettre » (fonction SQL
   `recipe_shopping_state`), et il n'est plus compté « à acheter ». Une ligne par article (les œufs de la quiche et du poisson pané : « Œuf · 4 », avec les deux
   plats), quantités additionnées, nom sans la quantité de la recette (« 2 boîtes de tomates pelées » devient « Tomates
   pelées · 800 g ») ; cocher la ligne coche tous ses articles. L'accueil compte les lignes de la même façon.
13. **Rappels** (cloche de l'accueil) : panneau qui monte du bas avec le menu du jour (ou le prochain), les minuteurs
   en cours et le nombre d'articles à acheter.

Produits achetés tels quels : la truite et le thon fumés de Lidl sont des tranches prêtes à manger (« Truite fumée
(tranches) ») ; Mistral reçoit le nom des produits achetés et la consigne de ne pas les traiter comme du poisson frais
entier à cuire.

Hors champ : petits-déjeuners, entrées, desserts, plateaux de fromages (seuls les plats principaux sont proposés).

## Équilibre et variété (moteur de menus)

Repères pour 7 repas, ramenés au nombre de repas prévus : poisson 2 fois, viande rouge 2 fois au plus, volaille 3 fois
au plus, légumineuses au moins une fois, 1 à 2 soirs sans viande ni poisson (préférences du foyer), des légumes à chaque
repas ; pas la même protéine, le même féculent ou la même cuisine deux jours de suite ; une recette servie n'est pas
reproposée avant 21 jours. Les produits frais sont utilisés avant leur fin de conservation (poisson 2 jours, viande 3,
légumes 7…) ; un repas choisi réserve ses ingrédients. Les recettes aimées remontent, celles qui déplaisent disparaissent.
Aliments exclus par le foyer : la viande principale du plat, mais aussi ses ingrédients (porc : jambon, lardons, chorizo,
saucisses, charcuterie, cordon bleu ; bœuf : bœuf, veau, corned beef) ; un ingrédient facultatif peut être laissé de côté.

## Mistral (offre gratuite)

- Texte : Mistral Small et Medium sont bloqués par l'offre gratuite de la clé ; la fonction utilise Ministral 14B
  (repli sur Ministral 8B). Les recettes renvoyées sont des brouillons, vérifiés (`validateRecipe`) avant enregistrement.
- Images : génération d'images Mistral (agent avec l'outil `image_generation`), ≈ 15 s par image, enregistrée dans le
  stockage Supabase (`recipe-images`). L'offre gratuite n'en a accepté que 7 avant de refuser : la fonction se met alors
  en pause 6 heures et l'application crée les images manquantes au fil de l'usage. Sans image, un dessin d'après les
  ingrédients s'affiche ; une photo prise par le foyer remplace l'image.
- Plats restés sans image : photo libre de Wikimedia Commons (licence libre, crédits dans Profil › Crédits des photos).
- Photos embarquées : les photos des plats (640 px, ≈ 4,4 Mo) et les vignettes des ingrédients (160 px, ≈ 1,5 Mo) sont
  dans l'application (`app/assets/plats`, `app/assets/ingredients`, table `app/src/lib/bundled.ts` générée par
  `app/scripts/photos-embarquees.mjs`) : affichage instantané, sans réseau. Une image en ligne plus récente (même recette,
  autre date) ou une recette ajoutée depuis est téléchargée à la place ; une photo du foyer reste prioritaire.
- Ingrédients sur fond blanc : sujet détouré (rembg) et centré sur un carré blanc, ou photo telle quelle (non recadrée)
  sur fond blanc pour les graines, poudres et photos mal détourées (`app/scripts/ingredients-fond-blanc.py`) ; vignette bordée sur la fiche.
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

## Campagne de tests réels (2 novembre 2026, version 0.20.0)

Parcours d'un utilisateur réel sur le compte du foyer (données sauvegardées avant, remises à l'identique après) :
planification de la fin de semaine (repas cochés, temps changés, refus et choix), fiche recette (personnes, liste de
courses, favori, note, minuteur, pas à pas, « C'est prêt », remarque envoyée à Mistral, version proposée refusée),
glisser-déposer (vers un autre jour, échange midi/soir), annulation d'un menu, rappels, liste de courses (cocher,
décocher, rechargement), onglet Recettes (recherche, favoris, filtres), ajout d'une recette collée (Mistral) puis
suppression, menu du jour par ingrédient (à acheter ce midi ; acheté ce soir à la place d'un menu prévu), préférences
(porc exclu puis remis), module produits, crédits, déconnexion, mauvais mot de passe, reconnexion, idées de Mistral
(refus, choix d'une idée), modification d'une recette du foyer, photo de la galerie, partage.

Corrigé : ouverture des propositions lente (requêtes à la suite), idées de Mistral lancées pour rien, glisser-déposer
impossible en attrapant la photo (web), porc caché proposé malgré l'exclusion (cordon bleu au jambon), liste de courses
en double, « Repas 6 sur 6 » pour un seul repas demandé, résumé de Mistral coupé au milieu d'un mot, note affichée avec
retard, recherches qui affichaient une réponse périmée, erreur de veille de l'écran en quittant la fiche (web), déjeuner
passé encore en tête de l'accueil le soir. Non essayé : récupération des tickets Lidl (elle importe de vrais tickets).

## Erreurs et absence de réseau

Les messages d'erreur sont en français, sans détail technique (`app/src/lib/errors.ts`) : sans réseau, « Pas de
connexion Internet. Vérifiez le Wi-Fi ou les données mobiles, puis réessayez. », précédé de l'action concernée. Un choix
de menu non enregistré le dit et rouvre le repas ; un refus de proposition est réessayé en silence (3 s, 10 s, 30 s).

## Limites connues

- La connexion Lidl dans l'application et la récupération des tickets depuis un téléphone n'ont pas encore été essayées
  sur un vrai téléphone (le même échange a été validé depuis l'ordinateur).
- Les recettes générées par un petit modèle sont parfois approximatives (étapes, portions) : elles sont montrées avant
  d'être enregistrées et peuvent être adaptées ensuite.
- Le stock est estimé d'après les tickets et les repas choisis dans l'application (pas d'inventaire).

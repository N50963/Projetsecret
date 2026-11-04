# Application mobile « MenuBily »

Charte graphique : canevas Claude Design « MenuMalin » (ancien nom de l'application) (claude.ai, artboards Accueil, Fiche recette, Propositions,
Courses, Paramètres, Connexion, états et planche de composants), reproduit au plus près :

- couleurs (`app/src/lib/theme.ts`) : fond crème #FEF3E3, cartes #FDF4E9, vert #2C5A27, vert doux #E7E3BE, texte
  orange #8A4B12 pour « à acheter », bande verte #445A33 en tête des écrans ;
- typographie : Roboto (police du système Android) ;
- logo (version 0.29.1) : visuel du foyer, marmite, nom et slogan (`app/assets/logo-menubily-source.png`), fond rendu
  transparent et réduit à 300 px de haut par `app/scripts/logo-menubily.py` (`assets/logo-menubily.webp`, 79 Ko) ;
  affiché en tête de l'accueil et sur l'écran de connexion ;
- icône de l'application : la marmite du logo (`app/assets/marmite-source.png`, extraite du logo par
  `app/scripts/logo-menubily.py`), déclinée par `app/scripts/icone-marmite.py` (icône adaptative sur fond crème, à
  thème, ronde et classique, écran de démarrage) ; icônes de l'interface :
  tracés SVG des maquettes (`app/src/components/icons.tsx`, react-native-svg) ;
- boutons pleine largeur à dégradé vert, puces beiges (vert doux bordé de vert quand elles sont choisies),
  barre du bas Accueil · Courses · Recettes · Profil.

Code : `app/` (Expo SDK 58, Expo Router, TypeScript). Données : Supabase (projet `avhqhvedgppuieellruz`).
Fonction serveur Mistral : `supabase/functions/mistral/index.ts` (la clé Mistral reste dans les secrets Supabase).

## Déroulé

1. **Connexion** au compte partagé du foyer (mêmes identifiants sur les deux téléphones), puis code du foyer
   la première fois. Clavier ouvert, la photo du haut se replie et le panneau
   (logo, e-mail, mot de passe, bouton) remonte au-dessus du clavier : sous Android, l'application s'affiche sous les
   barres du système et la fenêtre n'est plus réduite par le clavier.
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
   beige = libre), puis la carte du jour touché. En tête de la carte, un bandeau donne la météo du jour à
   Rochefort-du-Gard : icône du temps, températures minimale et maximale ; bleu-gris quand il fait frais ou froid,
   abricot quand il fait chaud, vert par temps doux (mêmes repères que les propositions, `weatherTone`). Un menu choisi y apparaît avec sa photo (toucher : fiche ; croix,
   dans sa propre colonne à droite : annuler) ; un repas libre se coche (« À proposer ») et reçoit son temps disponible (30 min, 1 h ou sans limite).
   Il est toujours affiché ; « Proposer les menus (n repas) » lance les propositions. Les repas du jour passés ne sont
   plus à prévoir : le déjeuner après 14 h, le dîner après 20 h (ils disparaissent de la carte du jour, du décompte et du
   menu du jour par ingrédient). Une fois la semaine choisie (des menus choisis, plus rien à proposer), les repas à
   prévoir sont repliés : la carte d'un jour ne montre que ses menus, le bouton des propositions disparaît, et un lien
   discret « Prévoir un autre repas » rouvre les repas à cocher (rien n'est alors coché d'avance ; ils se replient de
   nouveau au retour sur l'accueil s'ils n'ont pas été cochés). Chaque semaine est vide par défaut : aucun repas n'est
   coché d'avance (jusqu'à la version 0.29.0, le dîner de chaque jour l'était). Chaque case cochée ou décochée, et chaque
   temps choisi, est enregistré tout de suite dans Supabase (`setMealWanted` : repas « à proposer », ou passé quand il
   est décoché) : le choix est gardé au retour sur l'accueil, au redémarrage et sur les autres téléphones du foyer.
   « Proposer les menus » retire aussi les repas de la semaine restés « à proposer » d'une planification plus ancienne
   et non demandés : auparavant, après avoir choisi un seul menu, les dîners cochés d'avance la veille revenaient dans
   le calendrier. Un menu annulé redevient à prévoir (décoché). La liste de courses n'a plus de carte sur l'accueil : une pastille rouge sur l'onglet Courses de la barre du
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
8. **Fiches recettes** : photo du plat (icône d'appareil photo en haut de la photo : appareil photo ou galerie ; la photo prise
   avec le téléphone remplace l'image créée par Mistral, qui ne l'écrase jamais), temps de préparation, de cuisson et
   total en haut de la fiche (photo libre de Commons, image créée par Mistral ou visuel fourni par le foyer : 108 plats,
   fichiers de data/photos-plats copiés en ligne par la fonction foyer-photos ; photo gardée sur le téléphone, affichée
   dès l'ouverture de la fiche, avant même la lecture de la recette), ingrédients avec leur vignette (photo libre de droits de Wikimedia Commons, crédits dans
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
   non notées), note affichée sur chaque ligne. Un appui long sur une recette propose de la supprimer (panneau de
   confirmation au style de l'application). Sur la fiche, la corbeille de la bande verte supprime la recette ; les
   recettes ajoutées par le foyer ont en bas de fiche « Modifier la recette » et « Supprimer » ; les recettes de la base
   commune ne sont pas modifiables. Une recette supprimée est masquée pour le foyer (table `hidden_recipes`), pas
   effacée : elle quitte l'onglet Recettes, le tableau météo et les propositions, mais les menus déjà prévus avec elle
   gardent leur nom et leur fiche, qui propose « Remettre dans mes recettes ».
11. **Ajout de recettes** : cinq sources, mises en forme par Mistral (durées de cuisson, feu et température précisés :
   chaque étape avec une durée aura son minuteur) :
   - **Photo** de la recette (livre, fiche, écran, papier manuscrit), jusqu'à 4 pages (appareil photo ou galerie,
     réduites à 1 600 px) : un modèle de vision de Mistral lit le texte (action `import_photo`) ;
   - **Lien internet** de la page : la fonction lit ses données structurées schema.org « Recipe » (la plupart des sites
     de recettes), sinon son texte à partir des ingrédients (`import_url` ; adresses publiques seulement, 20 s et 3 Mo
     au plus) ;
   - **À voix haute** : la personne lit la recette, l'application l'enregistre (micro, m4a mono 32 kb/s, 8 minutes au
     plus) et Mistral la transcrit (Voxtral, `import_audio`) ;
   - **Coller un texte** ou **Saisir**.
   Le brouillon montre, repliable, ce que MenuBily a lu ou entendu, pour vérifier que rien ne manque. Une protéine
   principale « végétarienne » donnée à un plat de viande ou de poisson est corrigée d'après ses ingrédients. L'utilisateur relit et corrige tout dans
   l'éditeur avant d'enregistrer ; photo du plat facultative (appareil photo ou galerie), sinon Mistral crée une
   illustration.
12. **Favoris** : cœur dans la bande verte de la fiche ; filtre « Favoris » dans l'onglet Recettes. « Ajouter à ma
   liste » met sur la liste de courses les ingrédients marqués « à acheter » (ni de placard, ni encore à la maison selon
   le stock estimé des propositions). Quand tout est normalement à la maison, le bouton devient « Je n'en ai plus,
   j'ajoute à ma liste » : les ingrédients concernés se cochent (tous au départ) et rejoignent la liste, car le foyer a
   pu les consommer en dehors des menus prévus (fonction SQL `recipe_shopping_status`). Chaque ingrédient qui n'est pas déjà
   sur la liste a son propre panier au bout de sa ligne : un toucher l'ajoute seul à la liste (« Je n'en ai plus » pour
   un ingrédient acheté), y compris les produits de placard (sel, ail, huile d'olive), les ingrédients facultatifs et ceux
   hors référentiel, avec la quantité affichée pour le nombre de personnes.
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

## Saison et météo (Rochefort-du-Gard)

- **Prévision** : Open-Meteo (gratuit, sans compte ni clé ; modèles de Météo-France pour la France), 16 jours, lue
  chaque heure par Supabase (tâches planifiées `meteo-demande` à hh:12 et `meteo-enregistrement` à hh:14, table
  `weather_days`) ; le téléphone lit cette table et n'interroge Open-Meteo lui-même qu'en secours (table vide ou
  prévision de plus de 6 heures), car le quota gratuit d'Open-Meteo est compté par adresse internet. L'application ne
  relit la prévision qu'à son ouverture : au lancement, et au retour au premier plan après au moins 30 minutes en
  arrière-plan ; pendant l'utilisation, tous les écrans se servent de cette lecture. Hors réseau, la dernière prévision
  gardée sur le téléphone sert encore deux jours ; sans prévision, la météo ne compte pas.
- **Classement des recettes par temps** (Profil › Recettes selon la météo) : pour chaque recette, cinq boutons — temps
  froid, plutôt froid, tout temps, plutôt chaud, temps chaud —, recherche, filtres avec le nombre de recettes et filtre
  « À vérifier ». Le choix est enregistré pour le foyer (table `recipe_weather`) ; sans choix, une suggestion déduite du
  nom du plat s'affiche en pointillés (salades, taboulé, wraps : temps chaud ; papillotes, grillades : plutôt chaud ;
  gratins, purées, lasagnes : plutôt froid ; soupes, veloutés, raclette, tartiflette, grands mijotés : temps froid).
- **Effet sur les propositions** (température maximale du jour du repas) : 28 °C et plus : +4 pour un plat « temps
  chaud », +2 « plutôt chaud », −3 « plutôt froid », −5 « temps froid », −2 de plus pour une cuisson longue (plat non
  classé chaud) ; 24 à 27 °C : +1,5 / +1 / −1 / −1,5 ; 11 à 15 °C : +1,5 « temps froid », +1 « plutôt froid », −0,5 /
  −1 pour les plats chauds ; 10 °C et moins : +3 / +2 / −1,5 / −3 ; pluie (3 mm et plus) : +1,5 / +1 pour les plats froids,
  −1 « temps chaud ». La carte proposée l'indique (« Plat frais : 31 °C prévus », « Plat chaud et réconfortant : 8 °C au
  plus, pluie ») ; la météo du jour s'affiche sur les cartes de l'accueil et en tête des propositions ; les idées de
  Mistral reçoivent la consigne (« plat frais ou léger, sans four »).
- **Saison** : un plat hors saison recule (−6), un plat propre à la saison (une ou deux saisons) avance un peu (+1,5).

## Mistral (offre gratuite)

- Texte : Mistral Small et Medium sont bloqués par l'offre gratuite de la clé ; la fonction utilise Ministral 14B
  (repli sur Ministral 8B). Les recettes renvoyées sont des brouillons, vérifiés (`validateRecipe`) avant enregistrement.
- Images : génération d'images Mistral (agent avec l'outil `image_generation`), ≈ 15 s par image, enregistrée dans le
  stockage Supabase (`recipe-images`). L'offre gratuite n'en a accepté que 7 avant de refuser : la fonction se met alors
  en pause 6 heures et l'application crée les images manquantes au fil de l'usage. Sans image, un dessin d'après les
  ingrédients s'affiche ; une photo prise par le foyer remplace l'image.
- Plats restés sans image : photo libre de Wikimedia Commons (licence libre, crédits dans Profil › Crédits des photos).
- Illustrations toutes dans Supabase (version 0.27.0) : photos des plats (`recipe-images`, ≈ 1 173 px), photos du foyer
  (`household-photos`, privé) et vignettes des ingrédients sur fond blanc (`ingredient-images`, 160 px). Aucune n'est
  livrée avec l'application. Au lancement, l'application compare la liste en ligne (date de chaque image = sa version)
  aux fichiers du téléphone et télécharge les illustrations nouvelles ou modifiées dans son dossier permanent
  (`Paths.document/illustrations`, 6 téléchargements en parallèle), avec une barre discrète au-dessus des onglets
  (« Mise à jour des illustrations · 37 / 363 », puis « Illustrations à jour » et fondu). Les miniatures de 480 px des
  listes et du ruban de la semaine sont créées sur le téléphone (240 px jusqu'à la version 0.28 : floues dans les cases
  du ruban, refaites une fois depuis les photos du téléphone, sans réseau). Ensuite tout s'affiche depuis le téléphone,
  instantanément et sans réseau ; une nouvelle illustration ne demande pas de nouvelle version de l'application.
  Version 0.29.0 : une photo du téléphone s'affiche toujours nette, même quand une version plus récente attend son
  téléchargement (auparavant, la miniature floue s'affichait le temps de télécharger la nouvelle, plusieurs secondes
  pendant une mise à jour) ; les écrans se redessinent dès qu'une illustration arrive (`usePictures`), et les
  illustrations demandées par l'écran affiché sont téléchargées en premier. Première ouverture : ≈ 20 Mo (145 photos
  de plats et 217 vignettes). Liste relue toutes les 2 minutes au plus quand un écran demande des images (nouvel essai
  10 minutes après une coupure réseau). Code : `app/src/lib/images.ts`, barre `app/src/components/UpdateBar.tsx`.
- Ajouter ou remplacer des illustrations : visuels de plats dans `data/photos-plats/<id de recette>.jpg` (JPEG ≤ 400 Ko),
  vignettes d'ingrédients dans `data/ingredients/<slug>.jpg` (JPEG ≤ 100 Ko) ; commit, push, puis appel de la fonction
  `foyer-photos` (jeton `x-cron-token`) avec `{ ref: "<commit>", recipes: [...], ingredients: [...] }`. Les téléphones
  les téléchargent au lancement suivant.
- Ingrédients sur fond blanc : sujet détouré (rembg) et centré sur un carré blanc, ou photo telle quelle (non recadrée)
  sur fond blanc pour les graines, poudres et photos mal détourées (`app/scripts/ingredients-fond-blanc.py`, sortie dans
  `data/ingredients`) ; vignette bordée sur la fiche.
- Limite : 40 appels par heure et par foyer (journal `ai_calls`).
- Déploiement de la fonction `mistral` : son point d'entrée déployé importe `supabase/functions/mistral/index.ts` du
  dépôt GitHub à un commit figé (`https://raw.githubusercontent.com/n50963/projetsecret/<commit>/…`) ; le module est
  intégré au paquet de la fonction au déploiement (aucun accès à GitHub ensuite). Pour une nouvelle version : pousser
  le commit, puis redéployer la fonction avec ce numéro de commit (sans vérification de jeton, la fonction contrôle
  elle-même le compte et le jeton des tâches planifiées).
- Plan gratuit Supabase : voir `docs/plan-gratuit-supabase.md`.

## Installer l'application sur les téléphones

Depuis la version 0.24.0, la compilation produit un APK par architecture : `app-arm64-v8a-release.apk` (≈ 28 Mo) pour
les téléphones 64 bits, c'est-à-dire presque tous, et `app-armeabi-v7a-release.apk` pour un vieux téléphone 32 bits
(détail du poids dans `docs/poids-application.md`).

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

# Poids de l'application et réécriture en Rust

## D'où venaient les 65 Mo (version 0.23.0)

| Partie | Poids dans l'APK | Rôle |
|---|---|---|
| Bibliothèques natives 64 bits (arm64-v8a) | 23,8 Mo | React Native (6,7 Mo), moteur JavaScript Hermes (2,6 Mo), modules Expo, écrans, SVG, gestes, décodeurs d'images (AVIF, WebP)… |
| Bibliothèques natives 32 bits (armeabi-v7a) | 16,5 Mo | Les mêmes, pour les vieux téléphones 32 bits : inutiles sur un téléphone récent |
| Images embarquées | 11,6 Mo | Photos des 145 plats (640 px), leurs miniatures (240 px), 217 vignettes d'ingrédients, icônes |
| Code JavaScript (bytecode Hermes) | 4,3 Mo | Toute l'application, Supabase compris |
| Code Java/Kotlin (dex, déjà réduit par R8) | 3,7 Mo | Modules Android d'Expo, React Native, OkHttp, Glide… |
| Ressources Android | 2 Mo | Textes et ressources des bibliothèques |

Les recettes ne pèsent presque rien : elles sont dans Supabase, pas dans l'application. Le poids vient d'abord du socle
React Native embarqué deux fois (64 et 32 bits), stocké non compressé dans l'APK (réglage par défaut d'Android pour un
démarrage plus rapide), puis des photos embarquées pour un affichage instantané.

## Optimisations (version 0.24.0)

- **Un APK par architecture** (`splits.abi` dans `android/app/build.gradle`) : `app-arm64-v8a-release.apk` pour les
  téléphones 64 bits (tous les téléphones vendus depuis plusieurs années), `app-armeabi-v7a-release.apk` pour un vieux
  téléphone 32 bits. Chacun n'embarque que ses bibliothèques.
- **Bibliothèques natives compressées dans l'APK** (`expo.useLegacyPackaging=true`) : le fichier à télécharger est bien
  plus petit ; Android les décompresse à l'installation (place occupée sur le téléphone à peu près inchangée, installation
  un peu plus longue).
- **Images en WebP** au lieu de JPEG (`app/scripts/images-webp.py`) : photos des plats qualité 75, miniatures 75,
  vignettes d'ingrédients 80, photo de la connexion 75 : 10,8 Mo → 7,5 Mo, sans différence visible.
- Déjà en place : R8 (code Java/Kotlin réduit), Hermes (bytecode précompilé).

**Résultat (mesuré)** : 65,9 Mo → **27,8 Mo** pour un téléphone 64 bits (`app-arm64-v8a-release.apk`, −58 %), 26,7 Mo
pour un téléphone 32 bits.

| Partie (APK 64 bits) | 0.23.0 | 0.24.0 |
|---|---|---|
| Bibliothèques natives | 40,3 Mo (64 et 32 bits, non compressées) | 7,9 Mo (64 bits, compressées) |
| Images embarquées | 11,6 Mo | 8,4 Mo |
| Code JavaScript (Hermes) | 4,3 Mo | 4,3 Mo |
| Code Java/Kotlin (dex) | 3,7 Mo | 3,7 Mo |
| Ressources Android et divers | 2 Mo | 2 Mo |

Pistes écartées, faute de pouvoir les vérifier sur un vrai téléphone ou pour un gain trop faible :
- retirer Reanimated (≈ 2,8 Mo de bibliothèques) : `expo-router` l'embarque et le code JavaScript le charge ; sans son
  module natif, l'application risquerait de planter au démarrage ;
- réduction automatique des ressources Android (`shrinkResources`) : elle peut supprimer les images embarquées, retrouvées
  par leur nom à l'exécution ;
- compresser le bytecode JavaScript : démarrage plus lent pour ≈ 2 Mo.

## Illustrations hors de l'application (version 0.27.0)

Les photos des plats, leurs miniatures et les vignettes des ingrédients (≈ 8 Mo dans l'APK 0.26.0) ne sont plus livrées
avec l'application : elles sont toutes dans Supabase et téléchargées une fois par téléphone au lancement (barre de mise à
jour), puis gardées dans le dossier de l'application. L'APK ne grossit plus avec le nombre de recettes ; une nouvelle
illustration n'oblige plus à publier une nouvelle version.

## Réécrire l'application en Rust ?

**Possible, mais pas souhaitable.** Rust sait produire une application Android (interface native dessinée par Slint,
egui ou Makepad ; ou interface web dans la vue web du système avec Tauri ou Dioxus), mais :

- **Gain de poids limité après optimisation** : une application Rust de cette taille ferait de l'ordre de 10 à 20 Mo
  (moteur de dessin ou vue web, TLS, client HTTP, décodeurs d'images), contre ≈ 25 à 30 Mo pour MenuBily optimisé. Le
  gros du gain (65 → ≈ 28 Mo) s'obtient déjà sans réécriture.
- **Aucun gain de rapidité perceptible** : les attentes viennent du réseau (Supabase) et de Mistral (15 à 30 s par
  demande), pas du calcul ; le moteur de menus tourne déjà en quelques millisecondes. Seul le démarrage à froid pourrait
  gagner quelques dixièmes de seconde.
- **Coût très élevé** : tout réécrire (≈ 10 000 lignes et tous les écrans : ruban de la semaine, cartes à glisser,
  glisser-déposer, minuteurs, fiche, éditeur), sans équivalent prêt à l'emploi pour une grande partie de ce qu'Expo
  fournit (appareil photo, galerie, enregistrement de la voix, stockage sécurisé, vue web de connexion Lidl, cache
  d'images, notifications) ni bibliothèque Supabase officielle en Rust (connexion, renouvellement des jetons et requêtes
  à refaire à la main) : plusieurs mois de travail.
- **Perte des outils actuels** : la version web de l'application, qui sert aux aperçus et aux tests automatiques, et les
  mises à jour rapides de l'interface.

Le meilleur rapport gain/effort est donc d'optimiser l'application actuelle, ce qui est fait en 0.24.0.

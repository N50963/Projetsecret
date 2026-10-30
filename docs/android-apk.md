# Compiler l'APK Android avec Android Studio

Le projet Android natif est dans `app/android/` (généré par `expo prebuild`, puis versionné). Android Studio le compile en
un fichier APK à installer sur le téléphone. L'APK contient tout le code de l'application : il fonctionne sans
ordinateur allumé.

## 1. Installer les outils (une seule fois)

- **Git** : https://git-scm.com
- **Node.js 22 LTS** : https://nodejs.org (Gradle s'en sert pendant la compilation).
- **Android Studio** (dernière version) : https://developer.android.com/studio. Garder les choix par défaut :
  Android Studio installe le SDK Android et son propre Java (JDK 21).

Sous Windows, redémarrer l'ordinateur après l'installation de Node.js pour qu'Android Studio le trouve.

## 2. Récupérer le code

Sous Windows, choisir un dossier au chemin court (par exemple `C:\dev`) : certains chemins de compilation dépassent
sinon la limite de 260 caractères de Windows.

```bash
cd C:\dev                      # ou un dossier de votre choix sous macOS / Linux
git clone https://github.com/N50963/Projetsecret.git   # Git demande de se connecter à GitHub si le dépôt est privé
cd Projetsecret
git checkout ccr-dfe53054-07n16j
cd app
npm install
```

`npm install` est indispensable : la compilation Android lit les modules installés dans `app/node_modules`.
Après chaque `git pull`, relancer `npm install` dans `app/`.

## 3. Compiler dans Android Studio

1. **File › Open**, choisir le dossier `app/android` (pas `app/` ni la racine du dépôt), puis **Trust Project**.
2. Attendre la fin de la synchronisation Gradle (barre d'état en bas). La première fois, Android Studio télécharge
   Gradle 9.4.1, le SDK Android 37, les Build Tools 37.0.0, le NDK 27.1.12297006 et CMake 3.22.1 : compter 10 à 20
   minutes. S'il propose d'installer un composant manquant (« Install missing SDK package », « Accept licenses »),
   accepter.
3. **Build › Select Build Variant…** : pour le module `:app`, choisir **release**.
4. **Build › Generate App Bundles or APKs › Generate APKs** (selon la version : **Build › Build Bundle(s) / APK(s) ›
   Build APK(s)**). La première compilation dure 10 à 30 minutes.
5. À la fin, cliquer sur **locate** dans la notification : le fichier est
   `app/android/app/build/outputs/apk/release/app-release.apk` (≈ 60 Mo).

Même chose en ligne de commande, depuis `app/android` : `gradlew.bat assembleRelease` sous Windows,
`./gradlew assembleRelease` sous macOS / Linux.

## 4. Installer sur le téléphone

- **Par câble** : activer les options pour les développeurs et le débogage USB sur le téléphone, le brancher, le
  choisir dans la liste des appareils d'Android Studio, puis **Run ▶** (variante release sélectionnée).
- **Sans câble** : copier `app-release.apk` sur le téléphone (Google Drive, e-mail, câble), l'ouvrir et autoriser
  l'installation d'applications depuis cette source. Si Play Protect avertit d'une application inconnue, choisir
  « Installer quand même » (l'application n'est pas publiée sur le Play Store).

Faire de même sur le second téléphone.

## 5. Première ouverture

1. Se connecter avec l'e-mail et le mot de passe du compte du foyer (compte Supabase créé à l'avance, déjà relié au
   foyer et aux tickets importés). Le mot de passe se change dans **Préférences › Compte** ; il faut ensuite utiliser
   le nouveau sur l'autre téléphone.
2. **Connecter Lidl Plus** et se connecter sur la page Lidl, puis **Récupérer les nouveaux tickets**.

## Mettre à jour l'application

1. `git pull`, puis `npm install` dans `app/`.
2. Augmenter `versionCode` (et si besoin `versionName`) dans `app/android/app/build.gradle`.
3. Recompiler et installer le nouvel APK par-dessus l'ancien : les données restent (elles sont dans Supabase, la
   connexion Lidl reste dans le téléphone).

L'APK est signé avec la clé de débogage versionnée `app/android/app/debug.keystore`. Elle est la même sur tous les
ordinateurs : un APK compilé ailleurs s'installe donc par-dessus le précédent. Cette clé convient à un usage personnel,
pas à une publication sur le Play Store.

## En cas de problème

| Message | Solution |
|---|---|
| `Cannot run program "node"` ou `node: command not found` | Node.js n'est pas trouvé : redémarrer l'ordinateur (Windows) ; sous macOS, lancer Android Studio depuis le Terminal (`open -a "Android Studio"`). |
| `Could not find .../node_modules/...` | `npm install` n'a pas été lancé dans `app/`. |
| `Unsupported Java` / `Incompatible JDK` | **Settings › Build, Execution, Deployment › Build Tools › Gradle › Gradle JDK** : choisir le JDK 21 d'Android Studio (`jbr-21`). |
| `NDK ... did not have a source.properties file` ou `CMake 3.22.1 not found` | **Tools › SDK Manager › SDK Tools**, cocher « Show Package Details », installer NDK 27.1.12297006 et CMake 3.22.1. |
| `Filename longer than 260 characters` (Windows) | Recloner le dépôt dans un dossier court, par exemple `C:\dev`. |
| `Java heap space` / `OutOfMemoryError` | Dans `app/android/gradle.properties`, passer `-Xmx2048m` à `-Xmx4096m`. |
| L'application s'ouvre puis se ferme | Vérifier que `app/.env` est présent (adresse et clé publique Supabase) puis recompiler. |

## Notes pour la maintenance

- `app/android/` est désormais versionné : ne pas relancer `npx expo prebuild --clean`, qui l'écraserait. Si un module
  natif est ajouté, lancer `npx expo prebuild --platform android --no-install` puis vérifier le diff de
  `app/android/`, notamment `gradle.properties` (`reactNativeArchitectures=armeabi-v7a,arm64-v8a` : seulement les
  processeurs de téléphone, pour une compilation plus rapide et un APK plus léger).
- La variante release active la réduction du code (R8) : `android.enableMinifyInReleaseBuilds=true`.

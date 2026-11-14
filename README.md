# Lecteur Office — visionneuse de documents pour Android (Galaxy Z Fold 7)

Application Android **écrite en Rust** qui affiche fidèlement les documents
bureautiques Microsoft Office et OpenOffice / LibreOffice :

| Type | Formats |
|---|---|
| Traitement de texte | `.docx` `.docm` `.dotx` · `.doc` (Word 97-2003) · `.odt` `.ott` · `.rtf` |
| Tableur | `.xlsx` `.xlsm` `.xltx` · `.xlsb` · `.xls` (Excel 97-2003) · `.ods` · `.csv` |
| Présentation | `.pptx` `.ppsx` `.potx` · `.ppt` `.pps` (PowerPoint 97-2003) · `.odp` `.otp` |

L'APK prêt à installer se trouve dans [`release/LecteurOffice.apk`](release/LecteurOffice.apk).

## Installation sur le téléphone

1. Copiez `LecteurOffice.apk` sur le téléphone (ou téléchargez-le depuis GitHub).
2. Ouvrez-le depuis **Mes fichiers** ; autorisez « Installer des applications inconnues »
   pour l'application qui l'ouvre si Android le demande.
3. Lancez **Lecteur Office**.

Pour ouvrir un document :
- bouton **« Ouvrir un document »** (sélecteur Android : stockage interne, Drive, OneDrive…) ;
- ou depuis n'importe quelle application (Mes fichiers, Gmail, WhatsApp…) :
  **Ouvrir avec → Lecteur Office** ;
- les **documents récents** sont listés sur l'écran d'accueil.

## Fonctionnalités

- **Rendu fidèle** : moteur de mise en page maison (paragraphes, interlignes à la manière
  de Word, tabulations avec points de suite, listes numérotées, tableaux avec fusions,
  en-têtes / pieds de page avec numéros de page, notes, images, formes, graphiques).
- **Polices métriquement compatibles** embarquées : Carlito (≈ Calibri), Caladea (≈ Cambria),
  Liberation Sans / Serif / Mono (≈ Arial / Times New Roman / Courier New) — les lignes et
  les pages se coupent aux mêmes endroits que dans Office. Les polices système Android
  servent de secours (chinois, japonais, arabe, symboles…).
- **Tableur** : styles de cellules, bordures, remplissages, formats numériques (dates,
  monnaies, pourcentages…) affichés à la française, cellules fusionnées, texte qui déborde,
  « ### », en-têtes de lignes et colonnes, onglets de feuilles, images et graphiques.
  Les formules sans valeur enregistrée sont recalculées (SOMME, MOYENNE, SI, ARRONDI…).
- **Présentations** : héritage masque → disposition → diapositive, thèmes, dégradés,
  ~80 formes prédéfinies, tableaux stylés, graphiques, SmartArt (dessin enregistré).
- **Spécial Galaxy Z Fold 7** :
  - écran externe : une page / diapositive par ligne, ajustée à la largeur ;
  - écran interne déplié : **affichage livre sur deux pages** automatique ;
  - pliage / dépliage sans redémarrage, la page courante est conservée ;
  - prise en compte des barres système et de la caméra sous l'écran.
- **Navigation** : défilement inertiel, zoom à deux doigts (jusqu'à 800 %+),
  double-tap pour zoomer, rendu net à tous les niveaux (tuiles recalculées en arrière-plan,
  multi-cœurs).
- Fonctionne **hors ligne**, aucune permission demandée, aucune donnée collectée.

## Architecture

```
core/   bureau_core : bibliothèque Rust indépendante de l'interface
  ├─ ooxml/   docx, xlsx, pptx, DrawingML (formes, couleurs, thèmes), graphiques
  ├─ odf/     odt, ods, odp, graphiques ODF
  ├─ legacy/  doc (MS-DOC), xls (BIFF8), ppt (MS-PPT), rtf, csv, xlsb
  ├─ text.rs  mise en page des paragraphes (UAX #14, tabulations, justification)
  ├─ flow.rs  tableaux, sections, colonnes, pagination, en-têtes/pieds
  ├─ sheet.rs rendu des feuilles de calcul ; numfmt.rs formats Excel ; formula.rs formules
  ├─ fonts.rs base de polices et secours ; render.rs rasterisation (tiny-skia)
app/    lecteur : interface egui/eframe (Android NativeActivity + bureau pour les tests)
android/ manifeste, icône, et un petit pont Java (~150 lignes) pour les intents,
         le sélecteur de fichiers et les marges système — toute la logique est en Rust.
fonts/  polices embarquées (licences SIL OFL / Bitstream Vera dans fonts/licenses)
```

Le même moteur de rendu sert à l'application et aux tests : chaque page est rasterisée
par `tiny-skia`, ce qui garantit un rendu identique sur PC et sur le téléphone.

## Compilation

Prérequis : Rust (avec `rustup target add aarch64-linux-android`), JDK 17+,
SDK Android avec `platforms;android-36`, `build-tools;36.0.0`, `ndk;28.x`.

```bash
ANDROID_HOME=~/android-sdk ./build_apk.sh
```

L'APK signé est produit dans `target/apk/LecteurOffice.apk`. Le workflow
`.github/workflows/apk.yml` le reconstruit automatiquement à chaque push.

Outils de test sur PC :

```bash
# rend chaque page d'un document en PNG
cargo run --release -p bureau_core --example render -- document.docx sortie/ 1.5
# lance l'interface sur PC (glisser-déposer un fichier dans la fenêtre)
cargo run --release -p lecteur --bin lecteur-desktop -- document.xlsx
# simuler l'écran déplié du Z Fold 7
LECTEUR_TAILLE=840x757 cargo run --release -p lecteur --bin lecteur-desktop -- document.docx
```

`tools/gen_samples.py` génère des documents de test ; LibreOffice sert de référence
pour comparer les rendus.

> La clé de signature `android/lecteur.keystore` (mot de passe `lecteur`) est une clé de
> développement destinée à permettre les mises à jour de l'application installée.
> Pour une diffusion publique, générez votre propre clé (`KEYSTORE=... KS_PASS=... ./build_apk.sh`).

## Limites connues

- Application de **lecture seule** (pas d'édition) ; les macros ne sont jamais exécutées.
- Les images vectorielles **EMF/WMF** (anciens documents) et les objets OLE sans aperçu
  sont remplacés par un cadre gris.
- Les graphiques sont dessinés à partir des valeurs enregistrées (types courants : barres,
  colonnes, lignes, aires, secteurs, anneaux, nuages de points).
- Habillage du texte autour des images flottantes : les images sont superposées ou placées
  en bloc, sans contournement ligne à ligne.
- Formats 97-2003 : prise en charge solide du texte, des styles, tableaux et images ;
  les formes OfficeArt complexes et les graphiques `.xls` intégrés sont simplifiés.
- Documents protégés par mot de passe : non pris en charge (message explicite).

#!/usr/bin/env bash
# Construit l'APK Android (arm64-v8a, ex. Samsung Galaxy Z Fold 7) du Lecteur Office.
#
# Prérequis : Rust (+ cible aarch64-linux-android), JDK 17+, Android SDK avec
#   platforms;android-35+ , build-tools;35+ , ndk;27+
#
# Usage : ./build_apk.sh            -> target/apk/LecteurOffice.apk
#         ANDROID_HOME=/chemin/sdk ./build_apk.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"
BUILD_TOOLS="${BUILD_TOOLS:-$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)}"
PLATFORM="${PLATFORM:-$(ls -d "$ANDROID_HOME"/platforms/android-* | sort -V | tail -1)}"
NDK="${ANDROID_NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* | sort -V | tail -1)}"
MIN_SDK=26
TARGET_SDK=35
RUST_TARGET=aarch64-linux-android
ABI=arm64-v8a
HOST_TAG=linux-x86_64
case "$(uname -s)" in Darwin) HOST_TAG=darwin-x86_64 ;; esac
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/$HOST_TAG/bin"
ANDROID_JAR="$PLATFORM/android.jar"
OUT="$ROOT/target/apk"
KEYSTORE="${KEYSTORE:-$ROOT/android/lecteur.keystore}"
KS_PASS="${KS_PASS:-lecteur}"

echo "SDK        : $ANDROID_HOME"
echo "Build-tools: $BUILD_TOOLS"
echo "Plateforme : $PLATFORM"
echo "NDK        : $NDK"

# 1. Bibliothèque native Rust ---------------------------------------------------
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$TOOLCHAIN/aarch64-linux-android${MIN_SDK}-clang"
export CC_aarch64_linux_android="$TOOLCHAIN/aarch64-linux-android${MIN_SDK}-clang"
export CXX_aarch64_linux_android="$TOOLCHAIN/aarch64-linux-android${MIN_SDK}-clang++"
export AR_aarch64_linux_android="$TOOLCHAIN/llvm-ar"
# Alignement 16 Ko des segments ELF (exigé par Android 15+ sur certains appareils)
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384"
cargo build --release -p lecteur --lib --target "$RUST_TARGET"
SO="$ROOT/target/$RUST_TARGET/release/liblecteur.so"

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/stage/lib/$ABI" "$OUT/stage/assets/fonts"

# 2. Ressources + manifeste ------------------------------------------------------
"$BUILD_TOOLS/aapt2" compile --dir "$ROOT/android/res" -o "$OUT/res.zip"
"$BUILD_TOOLS/aapt2" link -o "$OUT/base.apk" \
    --manifest "$ROOT/android/AndroidManifest.xml" \
    -I "$ANDROID_JAR" \
    --min-sdk-version "$MIN_SDK" --target-sdk-version "$TARGET_SDK" \
    "$OUT/res.zip"

# 3. Pont Java (quelques dizaines de lignes) -> classes.dex ---------------------
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 \
    -bootclasspath "$ANDROID_JAR" -classpath "$ANDROID_JAR" \
    -d "$OUT/classes" $(find "$ROOT/android/java" -name '*.java')
"$BUILD_TOOLS/d8" --release --min-api "$MIN_SDK" --lib "$ANDROID_JAR" \
    --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')

# 4. Assemblage -------------------------------------------------------------------
cp "$SO" "$OUT/stage/lib/$ABI/liblecteur.so"
cp "$ROOT"/fonts/*.ttf "$OUT/stage/assets/fonts/" 2>/dev/null || true
cp "$OUT/dex/classes.dex" "$OUT/stage/classes.dex"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(
    cd "$OUT/stage"
    zip -q -X -9 "$OUT/unsigned.apk" classes.dex
    if ls assets/fonts/*.ttf >/dev/null 2>&1; then zip -q -X -9 -r "$OUT/unsigned.apk" assets; fi
    # Les bibliothèques natives doivent être stockées sans compression (extractNativeLibs=false)
    zip -q -X -0 -r "$OUT/unsigned.apk" lib
)
"$BUILD_TOOLS/zipalign" -f -P 16 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

# 5. Signature ------------------------------------------------------------------
if [ ! -f "$KEYSTORE" ]; then
    keytool -genkeypair -v -keystore "$KEYSTORE" -alias lecteur -keyalg RSA -keysize 2048 \
        -validity 10000 -storepass "$KS_PASS" -keypass "$KS_PASS" \
        -dname "CN=Lecteur Office, O=Projetsecret, C=FR" >/dev/null 2>&1
fi
"$BUILD_TOOLS/apksigner" sign --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" --ks-key-alias lecteur \
    --out "$OUT/LecteurOffice.apk" "$OUT/aligned.apk"
"$BUILD_TOOLS/apksigner" verify "$OUT/LecteurOffice.apk"

echo
echo "APK prêt : $OUT/LecteurOffice.apk ($(du -h "$OUT/LecteurOffice.apk" | cut -f1))"

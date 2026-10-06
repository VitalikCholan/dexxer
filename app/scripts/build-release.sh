#!/usr/bin/env bash
# app/scripts/build-release.sh — closed beta release APK, signed with the Dexxer
# release keystore (docs/beta-testing.md §0, docs/android-install-options.md §16).
#
#   app/scripts/build-release.sh [build-number]
#
# Reads keys/android/release-signing.env (gitignored), stamps
# EXPO_PUBLIC_BUILD_CHANNEL=beta and EXPO_PUBLIC_BUILD_NUMBER (default: the
# commit count), regenerates app/android with the signing plugin, runs
# `gradlew assembleRelease`, and copies the APK to app/dist/ with its SHA-256
# and the signing certificate check.
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$APP/.." && pwd)"
SIGNING="$ROOT/keys/android/release-signing.env"
[ -f "$SIGNING" ] || { echo "missing $SIGNING — see docs/beta-testing.md §0" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$SIGNING"
set +a
export EXPO_PUBLIC_BUILD_CHANNEL="${EXPO_PUBLIC_BUILD_CHANNEL:-beta}"
export EXPO_PUBLIC_BUILD_NUMBER="${1:-$(git -C "$ROOT" rev-list --count HEAD)}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export NODE_ENV=production

# React Native's native modules (CMake + prefab) fail under JDK 24+ ("A restricted
# method in java.lang.System has been called"). Use JDK 17 or 21 via JAVA_HOME.
JAVA_BIN="${JAVA_HOME:+$JAVA_HOME/bin/}java"
JAVA_MAJOR="$("$JAVA_BIN" -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)"
if [ -z "$JAVA_MAJOR" ] || [ "$JAVA_MAJOR" -ge 24 ]; then
  echo "JDK ${JAVA_MAJOR:-?} found; the Android build needs JDK 17 or 21 — run with JAVA_HOME=/path/to/jdk-21 $0" >&2
  exit 1
fi

cd "$APP"
npx expo prebuild -p android --no-install
(cd android && ./gradlew assembleRelease --no-daemon)

mkdir -p dist
OUT="dist/dexxer-beta-$EXPO_PUBLIC_BUILD_NUMBER.apk"
cp android/app/build/outputs/apk/release/app-release.apk "$OUT"
echo "APK: $APP/$OUT"
sha256sum "$OUT"
APKSIGNER="$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)apksigner"
if [ -x "$APKSIGNER" ]; then
  CERT="$("$APKSIGNER" verify --print-certs "$OUT" | sed -n 's/.*SHA-256 digest: //p' | head -1 | tr 'a-f' 'A-F' | sed 's/../&:/g; s/:$//')"
  echo "signing cert SHA-256: $CERT"
  [ "$CERT" = "$DEXXER_RELEASE_SHA256" ] && echo "OK: signed with the release key" || { echo "WARNING: not the release key ($DEXXER_RELEASE_SHA256)" >&2; exit 1; }
fi

#!/usr/bin/env bash
# Build the OpenFuture phone APK without Gradle.
# Requires: JDK 17 (JAVA_HOME), Android SDK with one platform + build-tools.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

# The machine-wide JAVA_HOME here is Java 8, which cannot target modern Android
# bytecode. Prefer an explicit OF_JAVA_HOME, otherwise the IDEA-bundled JDK 17.
JAVA_HOME="${OF_JAVA_HOME:-F:/PROGRAM_files/ideaIU-2023.3.2.win/jbr}"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$ROOT/.android-sdk/sdk}}"
export JAVA_HOME SDK
export PATH="$JAVA_HOME/bin:$PATH"

[ -d "$SDK" ] || { echo "Android SDK not found: $SDK (run mobile/android/install-sdk.sh)" >&2; exit 1; }

BT="$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)"
PLATFORM_DIR="$(ls -d "$SDK"/platforms/android-* 2>/dev/null | sort -V | tail -1)"
[ -n "$BT" ] && [ -n "$PLATFORM_DIR" ] || { echo "SDK needs build-tools and a platform (run install-sdk.sh)" >&2; exit 1; }
JAR="$PLATFORM_DIR/android.jar"
echo "SDK      $SDK"
echo "tools    $BT"
echo "platform $PLATFORM_DIR"

OUT="$HERE/build"
rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex"

echo "== javac"
javac --release 11 -encoding UTF-8 -cp "$JAR" -d "$OUT/classes" \
  $(find "$HERE/src" -name '*.java')

echo "== d8"
java -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 \
  --release --lib "$JAR" --min-api 24 --output "$OUT/dex" \
  $(find "$OUT/classes" -name '*.class')

echo "== aapt2 link"
EXTRA_RES=()
if [ -d "$HERE/res" ]; then
  "$BT/aapt2.exe" compile --dir "$HERE/res" -o "$OUT/res.zip"
  EXTRA_RES=(-R "$OUT/res.zip")
fi
"$BT/aapt2.exe" link \
  -o "$OUT/app.unsigned.apk" \
  -I "$JAR" \
  --manifest "$HERE/AndroidManifest.xml" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  "${EXTRA_RES[@]}"

echo "== add classes.dex"
python - "$OUT/app.unsigned.apk" "$OUT/dex/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
PY

echo "== zipalign"
"$BT/zipalign.exe" -f -p 4 "$OUT/app.unsigned.apk" "$OUT/app.aligned.apk"

echo "== sign (debug key)"
KS="$HERE/debug.keystore"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US"
fi
java -jar "$BT/lib/apksigner.jar" sign \
  --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --out "$HERE/OpenFuture-phone.apk" "$OUT/app.aligned.apk"

java -jar "$BT/lib/apksigner.jar" verify --print-certs "$HERE/OpenFuture-phone.apk" | head -5
ls -lh "$HERE/OpenFuture-phone.apk"
echo "APK ready: $HERE/OpenFuture-phone.apk"

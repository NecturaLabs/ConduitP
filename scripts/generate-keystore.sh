#!/usr/bin/env bash
# Conduit — Android APK signing keystore generator
#
# Run this ONCE to generate a signing keystore for the Android APK.
# The output values must be added as GitHub Actions repository secrets.
#
# Usage:
#   chmod +x scripts/generate-keystore.sh
#   ./scripts/generate-keystore.sh
#
# Requirements: Java (keytool) — available in any JDK install
set -euo pipefail

KEYSTORE_FILE="conduit-release.keystore"
KEY_ALIAS="conduit"

echo ""
echo "  Conduit — Android Signing Keystore Generator"
echo "  ============================================="
echo ""

# Prompt for passwords
read -rsp "  Enter keystore password (min 6 chars): " STORE_PASS
echo ""
read -rsp "  Confirm keystore password: " STORE_PASS_CONFIRM
echo ""

if [[ "$STORE_PASS" != "$STORE_PASS_CONFIRM" ]]; then
  echo "  Error: passwords do not match." >&2
  exit 1
fi

if [[ ${#STORE_PASS} -lt 6 ]]; then
  echo "  Error: password must be at least 6 characters." >&2
  exit 1
fi

read -rsp "  Enter key password (leave blank to use same as keystore): " KEY_PASS
echo ""

if [[ -z "$KEY_PASS" ]]; then
  KEY_PASS="$STORE_PASS"
fi

echo ""
echo "  Generating keystore..."
echo "  (You'll be asked for your name/org — this is embedded in the certificate)"
echo ""

keytool -genkey \
  -v \
  -keystore "$KEYSTORE_FILE" \
  -alias "$KEY_ALIAS" \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -storepass "$STORE_PASS" \
  -keypass "$KEY_PASS"

echo ""
echo "  Keystore generated: $KEYSTORE_FILE"
echo ""

# Extract SHA-256 fingerprint for Android App Links (assetlinks.json)
SHA256=$(keytool -list -v \
  -keystore "$KEYSTORE_FILE" \
  -alias "$KEY_ALIAS" \
  -storepass "$STORE_PASS" \
  2>/dev/null | grep 'SHA256:' | awk '{print $2}')

echo "  SHA-256 fingerprint: $SHA256"
echo ""
echo "  ================================================================"
echo "  Set this in your server environment (Dokploy / docker-compose):"
echo "  ================================================================"
echo ""
echo "  ASSETLINKS_FINGERPRINT=$SHA256"
echo ""
echo "  The API server serves it at GET /.well-known/assetlinks.json."
echo ""
echo "  ================================================================"
echo "  Add these 4 values as GitHub Actions repository secrets:"
echo "  (Settings → Secrets and variables → Actions → New repository secret)"
echo "  ================================================================"
echo ""
echo "  Secret name:  ANDROID_KEYSTORE_BASE64"
echo "  Secret value: (run the command below and paste the output)"
echo ""
echo "    base64 -w 0 $KEYSTORE_FILE"
echo ""
base64 -w 0 "$KEYSTORE_FILE"
echo ""
echo ""
echo "  Secret name:  ANDROID_KEY_ALIAS"
echo "  Secret value: $KEY_ALIAS"
echo ""
echo "  Secret name:  ANDROID_STORE_PASSWORD"
echo "  Secret value: $STORE_PASS"
echo ""
echo "  Secret name:  ANDROID_KEY_PASSWORD"
echo "  Secret value: $KEY_PASS"
echo ""
echo "  ================================================================"
echo "  IMPORTANT: Keep $KEYSTORE_FILE safe — it is in .gitignore."
echo "  If you lose it you cannot update the app on existing installs."
echo "  Back it up somewhere secure (e.g. a password manager)."
echo "  ================================================================"
echo ""

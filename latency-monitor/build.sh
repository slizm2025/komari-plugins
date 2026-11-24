#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$ROOT_DIR/plugin"
DIST_DIR="$ROOT_DIR/dist"

VERSION="$(node -e "console.log(require('$PLUGIN_DIR/komari-plugin.json').version)")"
SHORT="$(node -e "console.log(require('$PLUGIN_DIR/komari-plugin.json').short)")"
ZIP_NAME="komari-plugin-${SHORT}-v${VERSION}.zip"
ZIP_PATH="$DIST_DIR/$ZIP_NAME"

echo "[1/3] Running tests..."
node "$ROOT_DIR/tests/test_plugin.js"

echo "[2/3] Packaging $ZIP_NAME (manifest at archive root)..."
mkdir -p "$DIST_DIR"
rm -f "$ZIP_PATH"
(
  cd "$PLUGIN_DIR"
  zip -rq "$ZIP_PATH" . -x "*.DS_Store" -x "__MACOSX/*"
)

echo "[3/3] Verifying ZIP structure..."
unzip -l "$ZIP_PATH"
shasum -a 256 "$ZIP_PATH"
echo "Done: $ZIP_PATH"

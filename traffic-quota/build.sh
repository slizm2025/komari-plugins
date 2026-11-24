#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$ROOT_DIR/plugin"
DIST_DIR="$ROOT_DIR/dist"

VERSION="$(node -e "console.log(require('$PLUGIN_DIR/komari-plugin.json').version)")"
SHORT="$(node -e "console.log(require('$PLUGIN_DIR/komari-plugin.json').short)")"
ZIP_NAME="komari-plugin-${SHORT}-v${VERSION}.zip"
ZIP_PATH="$DIST_DIR/$ZIP_NAME"

echo "[1/4] Checking frontend JS syntax..."
node --check "$PLUGIN_DIR/assets/inject.js"
node -e '
  const fs = require("fs");
  const html = fs.readFileSync("'"$PLUGIN_DIR"'/pages/index.html", "utf8");
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("No inline script found");
  new Function(m[1]);
  console.log("pages/index.html inline script syntax OK");
'

echo "[2/4] Running unit and integration tests..."
node "$ROOT_DIR/tests/test_plugin.js"

echo "[3/4] Packaging $ZIP_NAME (manifest at archive root)..."
mkdir -p "$DIST_DIR"
rm -f "$ZIP_PATH"
(
  cd "$PLUGIN_DIR"
  zip -rq "$ZIP_PATH" . -x "*.DS_Store" -x "__MACOSX/*"
)

echo "[4/4] Verifying ZIP structure..."
unzip -l "$ZIP_PATH"
shasum -a 256 "$ZIP_PATH"
echo "Done: $ZIP_PATH"

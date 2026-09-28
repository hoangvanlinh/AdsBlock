#!/bin/bash
set -e
source "$(dirname "$0")/_build-lib.sh"

# === Firefox Build ===
# Usage: ./build-firefox.sh [obfuscate=false] [export_obfuscated_src=false] [debug=false]

OBFUSCATE="${1:-false}"
EXPORT_OBFUSCATED_SRC="${2:-false}"
DEBUG="${3:-false}"
validate_build_args
BUILD_TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(12).toString('hex'))")

BUILD_DIR="$BUILD_ROOT/dist-firefox"
ZIP_PATH="$BUILD_ROOT/adblock-extension-firefox.zip"
OBFUSCATED_SRC_DIR="$BUILD_ROOT/src-obfuscated-firefox"

echo -e "${YELLOW}[Firefox][1/4] Cleaning...${NC}"
rm -rf "$BUILD_DIR" && mkdir -p "$BUILD_DIR"
if [[ "$EXPORT_OBFUSCATED_SRC" == "true" ]]; then
  rm -rf "$OBFUSCATED_SRC_DIR" && mkdir -p "$OBFUSCATED_SRC_DIR"
fi

ensure_obfuscator

echo -e "${YELLOW}[Firefox][2/4] Copying static files...${NC}"
copy_static_files "$BUILD_DIR" "$PROJECT_DIR/manifest.firefox.json"

echo -e "${YELLOW}[Firefox][3/4] Processing JS files...${NC}"
for js in "${JS_FILES[@]}"; do cp "$PROJECT_DIR/$js" "$BUILD_DIR/$js"; done
substitute_qkv1_token "$BUILD_DIR"
if [[ "$DEBUG" == "true" ]]; then patch_debug "$BUILD_DIR"; fi
process_js_files "$BUILD_DIR"
if [[ "$DEBUG" != "true" ]]; then strip_debug_artifacts "$BUILD_DIR"; fi
node "$PROJECT_DIR/tools/validate-build.js" "$BUILD_DIR" "$DEBUG"
if [[ "$EXPORT_OBFUSCATED_SRC" == "true" ]]; then
  cp -R "$BUILD_DIR/." "$OBFUSCATED_SRC_DIR/"
fi

create_zip "$BUILD_DIR" "$ZIP_PATH"

echo -e "${GREEN}✅ Firefox build complete!${NC}"
echo "   ZIP: $ZIP_PATH  ($(du -h "$ZIP_PATH" | cut -f1))"
if [[ "$EXPORT_OBFUSCATED_SRC" == "true" ]]; then
  echo "   Obfuscated src: $OBFUSCATED_SRC_DIR"
fi

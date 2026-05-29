#!/bin/bash
set -e
source "$(dirname "$0")/_build-lib.sh"

# === Chrome Build ===
# Usage: ./build-chrome.sh [obfuscate=true] [export_obfuscated_src=false] [debug=false]

OBFUSCATE="${1:-true}"
EXPORT_OBFUSCATED_SRC="${2:-false}"
DEBUG="${3:-false}"

BUILD_DIR="$PROJECT_DIR/dist"
ZIP_PATH="$PROJECT_DIR/adblock-extension.zip"
OBFUSCATED_SRC_DIR="$PROJECT_DIR/src-obfuscated"

echo -e "${YELLOW}[Chrome][1/4] Cleaning...${NC}"
rm -rf "$BUILD_DIR" && mkdir -p "$BUILD_DIR"
if [[ "$EXPORT_OBFUSCATED_SRC" == "true" ]]; then
  rm -rf "$OBFUSCATED_SRC_DIR" && mkdir -p "$OBFUSCATED_SRC_DIR"
fi

ensure_obfuscator

echo -e "${YELLOW}[Chrome][2/4] Copying static files...${NC}"
copy_static_files "$BUILD_DIR" "$PROJECT_DIR/manifest.json"
[[ "$EXPORT_OBFUSCATED_SRC" == "true" ]] && copy_static_files "$OBFUSCATED_SRC_DIR" "$PROJECT_DIR/manifest.json"

echo -e "${YELLOW}[Chrome][3/4] Processing JS files...${NC}"
process_js_files "$BUILD_DIR"
[[ "$EXPORT_OBFUSCATED_SRC" == "true" ]] && process_js_files "$OBFUSCATED_SRC_DIR"

if [[ "$DEBUG" == "true" ]]; then
  echo -e "${YELLOW}[Chrome][3.5/4] Patching DEBUG_LOCAL=true...${NC}"
  patch_debug "$BUILD_DIR"
fi

echo -e "${YELLOW}[Chrome][4/4] Creating ZIP...${NC}"
create_zip "$BUILD_DIR" "$ZIP_PATH"

echo -e "${GREEN}✅ Chrome build complete!${NC}"
echo "   ZIP: $ZIP_PATH  ($(du -h "$ZIP_PATH" | cut -f1))"
if [[ "$EXPORT_OBFUSCATED_SRC" == "true" ]]; then
  echo "   Obfuscated src: $OBFUSCATED_SRC_DIR"
fi

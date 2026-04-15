#!/bin/bash
set -e

# === Config ===
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$PROJECT_DIR/dist"
ZIP_NAME="adblock-extension.zip"
FIREFOX_BUILD_DIR="$PROJECT_DIR/dist-firefox"
FIREFOX_ZIP_NAME="adblock-extension-firefox.zip"

# Target: "chrome" (default), "firefox", or "all"
TARGET="${1:-chrome}"

# Obfuscate: "true" (default) or "false" to skip obfuscation
OBFUSCATE="${2:-true}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}[1/4] Cleaning previous build...${NC}"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
if [[ "$TARGET" == "firefox" || "$TARGET" == "all" ]]; then
  rm -rf "$FIREFOX_BUILD_DIR"
  mkdir -p "$FIREFOX_BUILD_DIR"
fi

# Check if javascript-obfuscator is installed (only when obfuscation is enabled)
if [[ "$OBFUSCATE" == "true" ]] && ! command -v javascript-obfuscator &> /dev/null; then
    echo -e "${YELLOW}Installing javascript-obfuscator globally...${NC}"
    npm install -g javascript-obfuscator
fi

echo -e "${YELLOW}[2/4] Copying files...${NC}"
# Copy manifest and license
cp "$PROJECT_DIR/manifest.json" "$BUILD_DIR/"
cp "$PROJECT_DIR/LICENSE" "$BUILD_DIR/" 2>/dev/null || true

# Copy icons
mkdir -p "$BUILD_DIR/icons"
cp "$PROJECT_DIR/icons/"*.png "$BUILD_DIR/icons/"

# Copy CSS files
mkdir -p "$BUILD_DIR/content"
mkdir -p "$BUILD_DIR/rule"
mkdir -p "$BUILD_DIR/dashboard"
mkdir -p "$BUILD_DIR/popup"
cp "$PROJECT_DIR/content/content.css" "$BUILD_DIR/content/"
# Copy yt-adblock.js WITHOUT obfuscation (runs in MAIN world, must stay readable)
cp "$PROJECT_DIR/content/yt-adblock.js" "$BUILD_DIR/content/"
cp "$PROJECT_DIR/content/site-rules-loader.js" "$BUILD_DIR/content/"
cp "$PROJECT_DIR/rule/site-rules.txt" "$BUILD_DIR/rule/"
cp "$PROJECT_DIR/content/site-block.js" "$BUILD_DIR/content/"
cp "$PROJECT_DIR/dashboard/dashboard.css" "$BUILD_DIR/dashboard/"
cp "$PROJECT_DIR/popup/popup.css" "$BUILD_DIR/popup/"

# Copy HTML files
cp "$PROJECT_DIR/dashboard/dashboard.html" "$BUILD_DIR/dashboard/"
cp "$PROJECT_DIR/popup/popup.html" "$BUILD_DIR/popup/"

# Firefox build: copy same files with firefox manifest
if [[ "$TARGET" == "firefox" || "$TARGET" == "all" ]]; then
  cp "$PROJECT_DIR/manifest.firefox.json" "$FIREFOX_BUILD_DIR/manifest.json"
  cp "$PROJECT_DIR/LICENSE" "$FIREFOX_BUILD_DIR/" 2>/dev/null || true
  mkdir -p "$FIREFOX_BUILD_DIR/icons" "$FIREFOX_BUILD_DIR/content" "$FIREFOX_BUILD_DIR/rule" "$FIREFOX_BUILD_DIR/dashboard" "$FIREFOX_BUILD_DIR/popup"
  cp "$PROJECT_DIR/icons/"*.png "$FIREFOX_BUILD_DIR/icons/"
  cp "$PROJECT_DIR/content/content.css" "$FIREFOX_BUILD_DIR/content/"
  cp "$PROJECT_DIR/content/yt-adblock.js" "$FIREFOX_BUILD_DIR/content/"
  cp "$PROJECT_DIR/content/site-rules-loader.js" "$FIREFOX_BUILD_DIR/content/"
  cp "$PROJECT_DIR/rule/site-rules.txt" "$FIREFOX_BUILD_DIR/rule/"
  cp "$PROJECT_DIR/content/site-block.js" "$FIREFOX_BUILD_DIR/content/"
  cp "$PROJECT_DIR/dashboard/dashboard.css" "$FIREFOX_BUILD_DIR/dashboard/"
  cp "$PROJECT_DIR/popup/popup.css" "$FIREFOX_BUILD_DIR/popup/"
  cp "$PROJECT_DIR/dashboard/dashboard.html" "$FIREFOX_BUILD_DIR/dashboard/"
  cp "$PROJECT_DIR/popup/popup.html" "$FIREFOX_BUILD_DIR/popup/"
fi

echo -e "${YELLOW}[3/4] Obfuscating JavaScript files...${NC}"

OBFUSCATOR_OPTS=(
    --compact true
    --control-flow-flattening true
    --control-flow-flattening-threshold 0.5
    --dead-code-injection true
    --dead-code-injection-threshold 0.2
    --string-array true
    --string-array-encoding rc4
    --string-array-threshold 0.75
    --rename-globals false
    --self-defending false
    --identifier-names-generator hexadecimal
)

# Obfuscate each JS file
JS_FILES=(
    "background.js"
    "content/content.js"
    "content/site-rules-loader.js"
  "content/site-block.js"
    "dashboard/dashboard.js"
    "popup/popup.js"
)

for js in "${JS_FILES[@]}"; do
    if [[ "$OBFUSCATE" == "true" ]]; then
        echo "  Obfuscating $js..."
        javascript-obfuscator "$PROJECT_DIR/$js" \
            --output "$BUILD_DIR/$js" \
            "${OBFUSCATOR_OPTS[@]}"
        if [[ "$TARGET" == "firefox" || "$TARGET" == "all" ]]; then
            javascript-obfuscator "$PROJECT_DIR/$js" \
                --output "$FIREFOX_BUILD_DIR/$js" \
                "${OBFUSCATOR_OPTS[@]}"
        fi
    else
        echo "  Copying $js (no obfuscation)..."
        cp "$PROJECT_DIR/$js" "$BUILD_DIR/$js"
        if [[ "$TARGET" == "firefox" || "$TARGET" == "all" ]]; then
            cp "$PROJECT_DIR/$js" "$FIREFOX_BUILD_DIR/$js"
        fi
    fi
done

echo -e "${YELLOW}[4/4] Creating ZIP archive...${NC}"
cd "$BUILD_DIR"
zip -r "$PROJECT_DIR/$ZIP_NAME" . -x "*.DS_Store"
cd "$PROJECT_DIR"

if [[ "$TARGET" == "firefox" || "$TARGET" == "all" ]]; then
  cd "$FIREFOX_BUILD_DIR"
  zip -r "$PROJECT_DIR/$FIREFOX_ZIP_NAME" . -x "*.DS_Store"
  cd "$PROJECT_DIR"
fi

echo ""
echo -e "${GREEN}✅ Build complete!${NC}"
if [[ "$TARGET" == "chrome" || "$TARGET" == "all" ]]; then
  echo "   Chrome ZIP:  $PROJECT_DIR/$ZIP_NAME  ($(du -h "$PROJECT_DIR/$ZIP_NAME" | cut -f1))"
fi
if [[ "$TARGET" == "firefox" || "$TARGET" == "all" ]]; then
  echo "   Firefox ZIP: $PROJECT_DIR/$FIREFOX_ZIP_NAME  ($(du -h "$PROJECT_DIR/$FIREFOX_ZIP_NAME" | cut -f1))"
fi

#!/bin/bash
set -e

# === Config ===
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$PROJECT_DIR/dist"
ZIP_NAME="adblock-extension.zip"
FIREFOX_BUILD_DIR="$PROJECT_DIR/dist-firefox"
FIREFOX_ZIP_NAME="adblock-extension-firefox.zip"
OBFUSCATED_SRC_DIR="$PROJECT_DIR/src-obfuscated"
OBFUSCATED_SRC_FIREFOX_DIR="$PROJECT_DIR/src-obfuscated-firefox"

# Target: "chrome" (default), "firefox", or "all"
TARGET="${1:-chrome}"

# Obfuscate: "true" (default) or "false" to skip obfuscation
OBFUSCATE="${2:-true}"

# Export obfuscated source tree: "true" or "false" (default)
EXPORT_OBFUSCATED_SRC="${3:-false}"

# Debug mode: "true" loads local rule/site-rules.txt instead of remote/cache
DEBUG="${4:-false}"

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
if [[ "$EXPORT_OBFUSCATED_SRC" == "true" ]]; then
  rm -rf "$OBFUSCATED_SRC_DIR"
  mkdir -p "$OBFUSCATED_SRC_DIR"
  if [[ "$TARGET" == "firefox" || "$TARGET" == "all" ]]; then
    rm -rf "$OBFUSCATED_SRC_FIREFOX_DIR"
    mkdir -p "$OBFUSCATED_SRC_FIREFOX_DIR"
  fi
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
# Copy MAIN world scripts WITHOUT obfuscation (they run in page context)
cp "$PROJECT_DIR/content/yt-adblock.js" "$BUILD_DIR/content/"
cp "$PROJECT_DIR/content/anti-detect.js" "$BUILD_DIR/content/"
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
  cp "$PROJECT_DIR/content/anti-detect.js" "$FIREFOX_BUILD_DIR/content/"
  cp "$PROJECT_DIR/content/site-rules-loader.js" "$FIREFOX_BUILD_DIR/content/"
  cp "$PROJECT_DIR/rule/site-rules.txt" "$FIREFOX_BUILD_DIR/rule/"
  cp "$PROJECT_DIR/content/site-block.js" "$FIREFOX_BUILD_DIR/content/"
  cp "$PROJECT_DIR/dashboard/dashboard.css" "$FIREFOX_BUILD_DIR/dashboard/"
  cp "$PROJECT_DIR/popup/popup.css" "$FIREFOX_BUILD_DIR/popup/"
  cp "$PROJECT_DIR/dashboard/dashboard.html" "$FIREFOX_BUILD_DIR/dashboard/"
  cp "$PROJECT_DIR/popup/popup.html" "$FIREFOX_BUILD_DIR/popup/"
fi

if [[ "$EXPORT_OBFUSCATED_SRC" == "true" ]]; then
  cp "$PROJECT_DIR/manifest.json" "$OBFUSCATED_SRC_DIR/"
  cp "$PROJECT_DIR/LICENSE" "$OBFUSCATED_SRC_DIR/" 2>/dev/null || true
  mkdir -p "$OBFUSCATED_SRC_DIR/icons" "$OBFUSCATED_SRC_DIR/content" "$OBFUSCATED_SRC_DIR/rule" "$OBFUSCATED_SRC_DIR/dashboard" "$OBFUSCATED_SRC_DIR/popup"
  cp "$PROJECT_DIR/icons/"*.png "$OBFUSCATED_SRC_DIR/icons/"
  cp "$PROJECT_DIR/content/content.css" "$OBFUSCATED_SRC_DIR/content/"
  cp "$PROJECT_DIR/content/yt-adblock.js" "$OBFUSCATED_SRC_DIR/content/"
  cp "$PROJECT_DIR/content/anti-detect.js" "$OBFUSCATED_SRC_DIR/content/"
  cp "$PROJECT_DIR/content/site-rules-loader.js" "$OBFUSCATED_SRC_DIR/content/"
  cp "$PROJECT_DIR/rule/site-rules.txt" "$OBFUSCATED_SRC_DIR/rule/"
  cp "$PROJECT_DIR/content/site-block.js" "$OBFUSCATED_SRC_DIR/content/"
  cp "$PROJECT_DIR/dashboard/dashboard.css" "$OBFUSCATED_SRC_DIR/dashboard/"
  cp "$PROJECT_DIR/popup/popup.css" "$OBFUSCATED_SRC_DIR/popup/"
  cp "$PROJECT_DIR/dashboard/dashboard.html" "$OBFUSCATED_SRC_DIR/dashboard/"
  cp "$PROJECT_DIR/popup/popup.html" "$OBFUSCATED_SRC_DIR/popup/"

  if [[ "$TARGET" == "firefox" || "$TARGET" == "all" ]]; then
    cp "$PROJECT_DIR/manifest.firefox.json" "$OBFUSCATED_SRC_FIREFOX_DIR/manifest.json"
    cp "$PROJECT_DIR/LICENSE" "$OBFUSCATED_SRC_FIREFOX_DIR/" 2>/dev/null || true
    mkdir -p "$OBFUSCATED_SRC_FIREFOX_DIR/icons" "$OBFUSCATED_SRC_FIREFOX_DIR/content" "$OBFUSCATED_SRC_FIREFOX_DIR/rule" "$OBFUSCATED_SRC_FIREFOX_DIR/dashboard" "$OBFUSCATED_SRC_FIREFOX_DIR/popup"
    cp "$PROJECT_DIR/icons/"*.png "$OBFUSCATED_SRC_FIREFOX_DIR/icons/"
    cp "$PROJECT_DIR/content/content.css" "$OBFUSCATED_SRC_FIREFOX_DIR/content/"
    cp "$PROJECT_DIR/content/yt-adblock.js" "$OBFUSCATED_SRC_FIREFOX_DIR/content/"
    cp "$PROJECT_DIR/content/anti-detect.js" "$OBFUSCATED_SRC_FIREFOX_DIR/content/"
    cp "$PROJECT_DIR/content/site-rules-loader.js" "$OBFUSCATED_SRC_FIREFOX_DIR/content/"
    cp "$PROJECT_DIR/rule/site-rules.txt" "$OBFUSCATED_SRC_FIREFOX_DIR/rule/"
    cp "$PROJECT_DIR/content/site-block.js" "$OBFUSCATED_SRC_FIREFOX_DIR/content/"
    cp "$PROJECT_DIR/dashboard/dashboard.css" "$OBFUSCATED_SRC_FIREFOX_DIR/dashboard/"
    cp "$PROJECT_DIR/popup/popup.css" "$OBFUSCATED_SRC_FIREFOX_DIR/popup/"
    cp "$PROJECT_DIR/dashboard/dashboard.html" "$OBFUSCATED_SRC_FIREFOX_DIR/dashboard/"
    cp "$PROJECT_DIR/popup/popup.html" "$OBFUSCATED_SRC_FIREFOX_DIR/popup/"
  fi
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
      if [[ "$EXPORT_OBFUSCATED_SRC" == "true" ]]; then
        javascript-obfuscator "$PROJECT_DIR/$js" \
          --output "$OBFUSCATED_SRC_DIR/$js" \
          "${OBFUSCATOR_OPTS[@]}"
        if [[ "$TARGET" == "firefox" || "$TARGET" == "all" ]]; then
          javascript-obfuscator "$PROJECT_DIR/$js" \
            --output "$OBFUSCATED_SRC_FIREFOX_DIR/$js" \
            "${OBFUSCATOR_OPTS[@]}"
        fi
      fi
    else
        echo "  Copying $js (no obfuscation)..."
        cp "$PROJECT_DIR/$js" "$BUILD_DIR/$js"
        if [[ "$TARGET" == "firefox" || "$TARGET" == "all" ]]; then
            cp "$PROJECT_DIR/$js" "$FIREFOX_BUILD_DIR/$js"
        fi
      if [[ "$EXPORT_OBFUSCATED_SRC" == "true" ]]; then
        cp "$PROJECT_DIR/$js" "$OBFUSCATED_SRC_DIR/$js"
        if [[ "$TARGET" == "firefox" || "$TARGET" == "all" ]]; then
          cp "$PROJECT_DIR/$js" "$OBFUSCATED_SRC_FIREFOX_DIR/$js"
        fi
      fi
    fi
done

# ── Step 3.5: Debug mode — patch DEBUG_LOCAL=true ─────────────────
if [[ "$DEBUG" == "true" ]]; then
  echo -e "${YELLOW}[3.5/4] Debug mode: patching DEBUG_LOCAL=true in loader...${NC}"
  sed -i '' 's/var DEBUG_LOCAL=false/var DEBUG_LOCAL=true/' "$BUILD_DIR/content/site-rules-loader.js" 2>/dev/null || true
  if [[ "$TARGET" == "firefox" || "$TARGET" == "all" ]]; then
    sed -i '' 's/var DEBUG_LOCAL=false/var DEBUG_LOCAL=true/' "$FIREFOX_BUILD_DIR/content/site-rules-loader.js" 2>/dev/null || true
  fi
fi

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
if [[ "$EXPORT_OBFUSCATED_SRC" == "true" ]]; then
  echo "   Obfuscated source: $OBFUSCATED_SRC_DIR"
  if [[ "$TARGET" == "firefox" || "$TARGET" == "all" ]]; then
    echo "   Obfuscated source (Firefox): $OBFUSCATED_SRC_FIREFOX_DIR"
  fi
fi

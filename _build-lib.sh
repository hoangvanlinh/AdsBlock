#!/bin/bash
# === Shared build library — source this file, do not execute directly ===

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# JavaScript obfuscator options
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

# JS files to obfuscate (or copy when obfuscation is disabled)
JS_FILES=(
    "background.js"
    "content/content.js"
    "content/site-rules-loader.js"
    "content/site-block.js"
    "dashboard/dashboard.js"
    "popup/popup.js"
    "blocked/blocked.js"
)

# Ensure javascript-obfuscator is available
ensure_obfuscator() {
    if [[ "$OBFUSCATE" == "true" ]] && ! command -v javascript-obfuscator &> /dev/null; then
        echo -e "${YELLOW}Installing javascript-obfuscator globally...${NC}"
        npm install -g javascript-obfuscator
    fi
}

# Copy all static (non-JS) files into a destination directory.
# Usage: copy_static_files <DEST_DIR> <MANIFEST_SRC>
copy_static_files() {
    local DEST="$1"
    local MANIFEST="$2"

    cp "$MANIFEST" "$DEST/manifest.json"
    cp "$PROJECT_DIR/config.js" "$DEST/"
    cp "$PROJECT_DIR/LICENSE" "$DEST/" 2>/dev/null || true

    mkdir -p "$DEST/icons" "$DEST/content" "$DEST/rule" "$DEST/dashboard" "$DEST/popup" "$DEST/blocked"

    cp "$PROJECT_DIR/icons/"*.png "$DEST/icons/"
    cp "$PROJECT_DIR/content/content.css"         "$DEST/content/"
    cp "$PROJECT_DIR/content/site-rules-loader.js" "$DEST/content/"
    cp "$PROJECT_DIR/content/site-block.js"        "$DEST/content/"
    # scriptlets run in MAIN world — never obfuscated
    cp "$PROJECT_DIR/content/scriptlets.js"        "$DEST/content/"
    cp "$PROJECT_DIR/rule/site-rules.txt"          "$DEST/rule/"
    cp "$PROJECT_DIR/dashboard/dashboard.css"      "$DEST/dashboard/"
    cp "$PROJECT_DIR/dashboard/dashboard.html"     "$DEST/dashboard/"
    cp "$PROJECT_DIR/popup/popup.css"              "$DEST/popup/"
    cp "$PROJECT_DIR/popup/popup.html"             "$DEST/popup/"
    cp "$PROJECT_DIR/blocked/blocked.html"         "$DEST/blocked/"
}

# Obfuscate (or copy) all JS_FILES into DEST.
# Usage: process_js_files <DEST_DIR>
process_js_files() {
    local DEST="$1"
    for js in "${JS_FILES[@]}"; do
        if [[ "$OBFUSCATE" == "true" ]]; then
            echo "  Obfuscating $js..."
            javascript-obfuscator "$PROJECT_DIR/$js" \
                --output "$DEST/$js" \
                "${OBFUSCATOR_OPTS[@]}"
        else
            echo "  Copying $js (no obfuscation)..."
            cp "$PROJECT_DIR/$js" "$DEST/$js"
        fi
    done
}

# Patch DEBUG_LOCAL flag in config.js inside DEST — config.js is the single
# source read by both the content rule loader and the background DNR builder.
# Usage: patch_debug <DEST_DIR>
patch_debug() {
    local DEST="$1"
    sed -i '' 's/DEBUG_LOCAL: false/DEBUG_LOCAL: true/' \
        "$DEST/config.js" 2>/dev/null || true
}

# Create a ZIP archive from a directory.
# Usage: create_zip <SRC_DIR> <OUTPUT_ZIP_PATH>
create_zip() {
    local SRC_DIR="$1"
    local ZIP_PATH="$2"
    cd "$SRC_DIR"
    zip -r "$ZIP_PATH" . -x "*.DS_Store"
    cd "$PROJECT_DIR"
}

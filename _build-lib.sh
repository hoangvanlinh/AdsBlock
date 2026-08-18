#!/bin/bash
# === Shared build library — source this file, do not execute directly ===

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# All build output (dist*/, zips, obfuscated src exports) lives under here
# instead of cluttering the project root.
BUILD_ROOT="$PROJECT_DIR/build"

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

# Ensure terser is available (used by strip_debug_artifacts, NOT the
# obfuscation pipeline above — see that function's comment for why).
ensure_terser() {
    if [[ "$DEBUG" != "true" ]] && ! command -v terser &> /dev/null; then
        echo -e "${YELLOW}Installing terser globally...${NC}"
        npm install -g terser
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
    cp "$PROJECT_DIR/content/site-rules-loader.js" "$DEST/content/"
    cp "$PROJECT_DIR/content/site-block.js"        "$DEST/content/"
    # scriptlets run in MAIN world — never obfuscated
    cp "$PROJECT_DIR/content/element-picker.js"        "$DEST/content/"
    cp "$PROJECT_DIR/content/global-scanner.js"        "$DEST/content/"
    cp "$PROJECT_DIR/content/scriptlets.js"        "$DEST/content/"
    cp "$PROJECT_DIR/rule/site-rules.txt"          "$DEST/rule/"
    cp "$PROJECT_DIR/dashboard/dashboard.css"      "$DEST/dashboard/"
    cp "$PROJECT_DIR/dashboard/dashboard.html"     "$DEST/dashboard/"
    cp "$PROJECT_DIR/popup/popup.css"              "$DEST/popup/"
    cp "$PROJECT_DIR/popup/popup.html"             "$DEST/popup/"
    cp "$PROJECT_DIR/blocked/blocked.html"         "$DEST/blocked/"

    # web_accessible_resources/ (redirect-resource placeholders: noop.js,
    # 1x1.gif, popads-dummy.js, ...) — copied as-is, then every file in it
    # (except README.txt) gets merged into the manifest's own
    # web_accessible_resources[] list so that array never needs hand-editing
    # when a file is added/removed from the folder.
    if [[ -d "$PROJECT_DIR/web_accessible_resources" ]]; then
        cp -r "$PROJECT_DIR/web_accessible_resources" "$DEST/"
        node "$PROJECT_DIR/_js/inject-web-accessible-resources.js" "$DEST/manifest.json"
    fi
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

# Substitute the __QKV1_BUILD_TOKEN__ placeholder (content/scriptlets.js,
# content/content.js, content/site-block.js) with one random token per
# build — checked-in source only ever has the placeholder, never the value
# any shipped build actually uses. Runs unconditionally (every build, debug
# or not) since the placeholder isn't a functional value on its own — must
# run AFTER copy_static_files/process_js_files, which is what actually
# populates DEST from source.
# Usage: substitute_qkv1_token <DEST_DIR>
substitute_qkv1_token() {
    local DEST="$1"
    local token
    token=$(openssl rand -hex 12 2>/dev/null || node -e "console.log(require('crypto').randomBytes(12).toString('hex'))")
    while IFS= read -r -d '' js; do
        sed -i '' "s/__QKV1_BUILD_TOKEN__/${token}/g" "$js" 2>/dev/null || true
    done < <(find "$DEST" -name '*.js' -print0)
}

# Patch DEBUG_LOCAL flag in config.js inside DEST — config.js is the single
# source read by both the content rule loader and the background DNR builder.
# Usage: patch_debug <DEST_DIR>
patch_debug() {
    local DEST="$1"
    sed -i '' 's/DEBUG_LOCAL: false/DEBUG_LOCAL: true/' \
        "$DEST/config.js" 2>/dev/null || true
}

# Strip every comment and console.* call from every shipped .js file — run
# for production (debug=false) builds only, over the FULLY-POPULATED DEST
# dir (after copy_static_files + process_js_files), so it uniformly covers
# obfuscated files, un-obfuscated files, and content/scriptlets.js /
# content/site-rules-loader.js (which are never run through the obfuscator
# at all — see JS_FILES above).
#
# Deliberately NOT javascript-obfuscator: Chrome Web Store's Developer
# Program Policies restrict genuinely obfuscated (deliberately unreadable)
# code — control-flow flattening, string-array encoding, etc. Plain comment
# and console-output stripping isn't "obfuscation" in that sense (nothing
# about the code's logic or naming changes), so terser is used instead,
# with compression's default optimization passes turned OFF except
# drop_console — this is NOT a general minifier pass, just comment/log
# removal with no other transformation of the code.
# Usage: strip_debug_artifacts <DEST_DIR>
strip_debug_artifacts() {
    local DEST="$1"
    ensure_terser
    local js tmp
    while IFS= read -r -d '' js; do
        echo "  Stripping comments/console from ${js#$DEST/}..."
        tmp="$js.stripped"
        # --format beautify=true,comments=false — NOT bare --beautify/-b,
        # which this terser version silently ignores as a boolean flag (only
        # takes effect via --format's sub-options). Without it, terser's
        # default compact single-line output reads as "obfuscated" even
        # though nothing but comments/console calls were removed.
        if terser "$js" \
            --compress "defaults=false,drop_console=true" \
            --format "beautify=true,comments=false" \
            -o "$tmp" 2>/dev/null; then
            mv "$tmp" "$js"
        else
            echo -e "${YELLOW}  Warning: terser failed on $js — left as-is.${NC}"
            rm -f "$tmp"
        fi
    done < <(find "$DEST" -name '*.js' -print0)
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

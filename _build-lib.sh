#!/bin/bash
# === Shared build library — source this file, do not execute directly ===

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# All build output (dist*/, zips, obfuscated src exports) lives under here
# instead of cluttering the project root.
BUILD_ROOT="${ADBLOCK_BUILD_ROOT:-$PROJECT_DIR/build}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# JS files to obfuscate (or copy when obfuscation is disabled)
JS_FILES=(
    "shared/background.js"
    "content/content.js"
    "content/site-rules-loader.js"
    "content/site-block.js"
    "dashboard/dashboard.js"
    "popup/popup.js"
    "blocked/blocked.js"
)

# Builds use only lockfile-installed tools. Never install global dependencies.
OBFUSCATOR="$PROJECT_DIR/node_modules/.bin/javascript-obfuscator"
TERSER="$PROJECT_DIR/node_modules/.bin/terser"
ensure_obfuscator() {
    if [[ "$OBFUSCATE" == "true" && ! -x "$OBFUSCATOR" ]]; then
        echo "Missing local javascript-obfuscator. Run npm ci." >&2
        exit 1
    fi
}
ensure_terser() {
    if [[ "$DEBUG" != "true" && ! -x "$TERSER" ]]; then
        echo "Missing local terser. Run npm ci." >&2
        exit 1
    fi
}
validate_build_args() {
    for value in "$OBFUSCATE" "$EXPORT_OBFUSCATED_SRC" "$DEBUG"; do
        [[ "$value" == true || "$value" == false ]] || { echo "Expected true or false, got: $value" >&2; exit 1; }
    done
    ensure_obfuscator
    ensure_terser
}

# Copy all static (non-JS) files into a destination directory.
# Usage: copy_static_files <DEST_DIR> <MANIFEST_SRC>
copy_static_files() {
    local DEST="$1"
    local MANIFEST="$2"

    cp "$MANIFEST" "$DEST/manifest.json"
    mkdir -p "$DEST/shared"
    # config.js, browser-compat.js (self.EXT / self.EXT_SESSION_STORAGE), and
    # scriptlet-alias-map.js all live in shared/ and get loaded the same
    # dual-context way: background.js's importScripts(), the isolated-world
    # content_scripts js array, and dashboard/popup/blocked's own <script>
    # tags. scripts/convert-uassets.js and convert-regions.js also require()
    # scriptlet-alias-map.js offline from shared/ directly — scripts/ itself is
    # dev-only tooling, never copied here.
    for module in abp-converter rule-parser rule-fetcher settings-controller settings-ui; do
        cp "$PROJECT_DIR/shared/$module.js" "$DEST/shared/"
    done
    cp "$PROJECT_DIR/shared/config.js" "$DEST/shared/"
    cp "$PROJECT_DIR/shared/browser-compat.js" "$DEST/shared/"
    cp "$PROJECT_DIR/shared/local-storage.js" "$DEST/shared/"
    cp "$PROJECT_DIR/shared/session-storage.js" "$DEST/shared/"
    cp "$PROJECT_DIR/shared/focus-mode.js" "$DEST/shared/"
    cp "$PROJECT_DIR/shared/diag-logger.js" "$DEST/shared/"
    cp "$PROJECT_DIR/shared/scriptlet-alias-map.js" "$DEST/shared/"
    cp "$PROJECT_DIR/shared/utils.js" "$DEST/shared/"
    cp "$PROJECT_DIR/shared/i18n.js" "$DEST/shared/"
    cp "$PROJECT_DIR/LICENSE" "$DEST/" 2>/dev/null || true

    # _locales/ (chrome.i18n messages — manifest.json's default_locale +
    # __MSG_x__ fields resolve against this) — the one deliberate exception
    # to this function's explicit per-file whitelist: it's inherently a
    # directory that grows over time as languages are added, and requiring
    # an edit here per new language file would defeat "add a language = drop
    # in one messages.json, no code changes."
    mkdir -p "$DEST/_locales"
    cp -r "$PROJECT_DIR/_locales/"* "$DEST/_locales/"
    # rule-editor.js and global-scanner.js stay English-only for now (request
    # 2026-08-29) — strip their ruleEditor_*/scanner_* keys from every
    # non-English locale in THIS BUILD'S OUTPUT only; the source _locales/
    # files above are untouched, so this is trivially reversible later.
    node "$PROJECT_DIR/tools/strip-picker-only-locale-keys.js" "$DEST/_locales"

    mkdir -p "$DEST/icons" "$DEST/content" "$DEST/rule" "$DEST/dashboard" "$DEST/popup" "$DEST/blocked"

    cp "$PROJECT_DIR/icons/"*.png "$DEST/icons/"
    cp "$PROJECT_DIR/content/site-rules-loader.js" "$DEST/content/"
    cp "$PROJECT_DIR/content/fastpath-storage.js"  "$DEST/content/"
    cp "$PROJECT_DIR/content/site-block.js"        "$DEST/content/"
    # scriptlets run in MAIN world — never obfuscated
    cp "$PROJECT_DIR/content/element-picker.js"        "$DEST/content/"
    cp "$PROJECT_DIR/content/global-scanner.js"        "$DEST/content/"
    cp "$PROJECT_DIR/content/rule-editor.js"        "$DEST/content/"
    cp "$PROJECT_DIR/content/scriptlets.js"        "$DEST/content/"
    cp "$PROJECT_DIR/content/focus-block-overlay.js" "$DEST/content/"
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
        node "$PROJECT_DIR/tools/inject-web-accessible-resources.js" "$DEST/manifest.json"
    fi
}

# Optionally obfuscate already-copied and patched JS_FILES in DEST.
# Usage: process_js_files <DEST_DIR>
process_js_files() {
    local DEST="$1"
    for js in "${JS_FILES[@]}"; do
        if [[ "$OBFUSCATE" == "true" ]]; then
            echo "  Obfuscating $js..."
            node "$PROJECT_DIR/tools/obfuscate-file.js" "$DEST/$js"
        else
            echo "  Keeping $js (no obfuscation)..."
        fi
    done
}

# Substitute the __QKV1_BUILD_TOKEN__ placeholder (content/scriptlets.js,
# content/content.js, content/site-block.js) with one random token per
# build — checked-in source only ever has the placeholder, never the value
# any shipped build actually uses. Runs unconditionally (every build, debug
# or not) since the placeholder isn't a functional value on its own — must
# run after copying source and BEFORE obfuscation can encode the placeholder.
# Usage: substitute_qkv1_token <DEST_DIR>
substitute_qkv1_token() {
    node "$PROJECT_DIR/tools/patch-build.js" "$1" token "$BUILD_TOKEN"
}

patch_debug() {
    node "$PROJECT_DIR/tools/patch-build.js" "$1" debug
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
        if "$TERSER" "$js" \
            --compress "defaults=false,drop_console=true" \
            --format "beautify=true,comments=false" \
            -o "$tmp"; then
            mv "$tmp" "$js"
        else
            echo "terser failed on $js; refusing to package incomplete output" >&2
            rm -f "$tmp"
            return 1
        fi
    done < <(find "$DEST" -name '*.js' -print0)
}

# Create a ZIP archive from a directory.
# Usage: create_zip <SRC_DIR> <OUTPUT_ZIP_PATH>
create_zip() {
    local SRC_DIR="$1"
    local ZIP_PATH="$2"
    local TEMP_ZIP="$ZIP_PATH.tmp.zip"
    rm -f "$TEMP_ZIP"
    (cd "$SRC_DIR" && zip -r "$TEMP_ZIP" . -x "*.DS_Store")
    mv "$TEMP_ZIP" "$ZIP_PATH"
}

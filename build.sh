#!/bin/bash
set -e

# === Orchestrator — delegates to per-target build scripts ===
# Usage: ./build.sh [target=chrome] [obfuscate=true] [export_obfuscated_src=false] [debug=false]
# Targets: chrome | firefox | edge | all

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_ROOT="$SCRIPT_DIR/build"

TARGET="${1:-chrome}"
OBFUSCATE="${2:-true}"
EXPORT_OBFUSCATED_SRC="${3:-false}"
DEBUG="${4:-false}"

echo "Cleaning $BUILD_ROOT..."
rm -rf "$BUILD_ROOT"

run() {
    bash "$SCRIPT_DIR/build-$1.sh" "$OBFUSCATE" "$EXPORT_OBFUSCATED_SRC" "$DEBUG"
}

case "$TARGET" in
    chrome)  run chrome ;;
    firefox) run firefox ;;
    edge)    run edge ;;
    all)     run chrome; run firefox; run edge ;;
    *)       echo "Unknown target: '$TARGET'. Use: chrome | firefox | edge | all"; exit 1 ;;
esac

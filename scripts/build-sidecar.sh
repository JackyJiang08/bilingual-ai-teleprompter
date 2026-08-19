#!/usr/bin/env bash
# Builds the on-device speech recognition sidecar and places it where Tauri's
# externalBin expects it: src-tauri/binaries/speech-sidecar-<target-triple>.
# Usage: scripts/build-sidecar.sh [target-triple]
set -euo pipefail
cd "$(dirname "$0")/.."

# Triple resolution: explicit arg > Tauri build-hook env (set when tauri
# build runs with --target, e.g. CI cross-builds) > host architecture.
TRIPLE="${1:-${TAURI_ENV_TARGET_TRIPLE:-}}"
if [ -z "$TRIPLE" ]; then
  case "$(uname -m)" in
    arm64)  TRIPLE="aarch64-apple-darwin" ;;
    x86_64) TRIPLE="x86_64-apple-darwin" ;;
    *) echo "Unsupported arch $(uname -m); pass a target triple explicitly." >&2; exit 1 ;;
  esac
fi

OUT="src-tauri/binaries/speech-sidecar-$TRIPLE"
mkdir -p src-tauri/binaries

SWIFT_ARCH="${TRIPLE%%-*}"
[ "$SWIFT_ARCH" = "aarch64" ] && SWIFT_ARCH="arm64"

swiftc -O -swift-version 5 \
  -target "$SWIFT_ARCH-apple-macosx13.0" \
  -framework Speech -framework AVFoundation \
  -o "$OUT" \
  src-tauri/sidecar/speech-sidecar.swift

echo "Built $OUT"

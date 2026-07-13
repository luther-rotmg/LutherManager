#!/usr/bin/env bash
#
# Build the Windows installer and sync it to the Windows desktop.
#
# Usage:
#   ./scripts/installer-to-desktop.sh              # NSIS installer + portable
#   ./scripts/installer-to-desktop.sh portable     # portable only (faster, no NSIS)
#
set -euo pipefail

CLIENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="/mnt/c/Users/Jesse/Desktop"
DEST="$DESKTOP/Hive-Installer"
MODE="${1:-full}"

cd "$CLIENT_DIR"

if [[ ! -d "$DESKTOP" ]]; then
  echo "ERROR: Windows desktop not found at $DESKTOP" >&2
  exit 1
fi

echo "==> Building (mode: $MODE) ..."
if [[ "$MODE" == "portable" ]]; then
  npm run dist:portable
else
  npm run dist
fi

echo "==> Syncing artifacts to desktop ..."
mkdir -p "$DEST"

# Copy installer + portable exes (skip the unpacked dir and metadata noise).
shopt -s nullglob
copied=0
for f in release/*.exe; do
  cp -f "$f" "$DEST/"
  echo "    $(basename "$f")  ->  $DEST"
  copied=$((copied + 1))
done
shopt -u nullglob

if [[ "$copied" -eq 0 ]]; then
  echo "ERROR: no .exe produced in release/ -- build likely failed" >&2
  exit 1
fi

echo "==> Done. $copied file(s) on your desktop:"
echo "    Windows path:  C:\\Users\\Jesse\\Desktop\\Hive-Installer"

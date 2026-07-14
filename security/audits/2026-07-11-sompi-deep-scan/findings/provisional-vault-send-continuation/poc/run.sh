#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET=${SOMPI_TARGET:-"$ROOT/target"}

if [ ! -f "$TARGET/dist/vault.js" ]; then
  echo "Sompi build not found. Run: sh prepare-target.sh" >&2
  exit 1
fi

SOMPI_TARGET="$TARGET" node "$ROOT/reproduce.mjs"

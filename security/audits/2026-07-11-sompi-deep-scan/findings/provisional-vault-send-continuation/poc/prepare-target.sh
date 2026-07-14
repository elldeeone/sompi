#!/bin/sh
set -eu

REVISION=4ebb82d4f82bac46ae3addd112c4752f29630a8a
REPOSITORY=https://github.com/elldeeone/sompi
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET="$ROOT/target"

if [ -e "$TARGET" ]; then
  echo "target already exists; remove it explicitly before preparing again" >&2
  exit 1
fi

git clone "$REPOSITORY" "$TARGET"
git -C "$TARGET" checkout --detach "$REVISION"

actual=$(git -C "$TARGET" rev-parse HEAD)
if [ "$actual" != "$REVISION" ]; then
  echo "unexpected target revision: $actual" >&2
  exit 1
fi

npm --prefix "$TARGET" ci
npm --prefix "$TARGET" run build

echo "[+] prepared Sompi revision $REVISION"

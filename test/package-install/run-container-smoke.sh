#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! -f $1 ]]; then
  echo "usage: test/package-install/run-container-smoke.sh PACKAGE.tgz" >&2
  exit 2
fi

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
archive=$(realpath "$1")
readonly image_reference="node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94"

if ! command -v docker >/dev/null 2>&1; then
  echo "package install smoke requires Docker" >&2
  exit 1
fi

exec docker run --rm --init --pull=missing \
  --mount "type=bind,src=$archive,dst=/package.tgz,readonly" \
  --mount "type=bind,src=$repository_root/scripts/install-runtime-package.mjs,dst=/install-runtime-package.mjs,readonly" \
  --mount "type=bind,src=$repository_root/test/package-install/container-smoke.sh,dst=/container-smoke.sh,readonly" \
  "$image_reference" \
  bash /container-smoke.sh

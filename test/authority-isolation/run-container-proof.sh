#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "usage: test/authority-isolation/run-container-proof.sh" >&2
  exit 2
fi

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
readonly image_reference="node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94"

if ! command -v docker >/dev/null 2>&1; then
  echo "authority isolation proof requires Docker" >&2
  exit 1
fi

source_commit=$(git -C "$repository_root" rev-parse HEAD 2>/dev/null || printf 'unavailable')
if [[ -n $(git -C "$repository_root" status --porcelain 2>/dev/null || printf 'unknown') ]]; then
  source_dirty=true
else
  source_dirty=false
fi

exec docker run --rm --init --pull=missing \
  --mount "type=bind,src=$repository_root,dst=/source,readonly" \
  --env "SOMPI_PROOF_IMAGE=$image_reference" \
  --env "SOMPI_PROOF_SOURCE_COMMIT=$source_commit" \
  --env "SOMPI_PROOF_SOURCE_DIRTY=$source_dirty" \
  "$image_reference" \
  bash /source/test/authority-isolation/container-proof.sh

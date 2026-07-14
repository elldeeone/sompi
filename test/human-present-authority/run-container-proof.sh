#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  echo "usage: test/human-present-authority/run-container-proof.sh OUTPUT.json" >&2
  exit 2
fi
if [[ ! -t 0 || ! -t 2 ]]; then
  echo "human-present authority proof requires an interactive terminal" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "human-present authority proof requires Docker" >&2
  exit 1
fi

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
output_path=$(realpath -m -- "$1")
readonly image_reference="node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94"
[[ ! -e "$output_path" ]] || {
  echo "refusing to overwrite the human-present proof report: $output_path" >&2
  exit 1
}

output_directory=$(mktemp -d)
cleanup() {
  rm -rf "$output_directory"
}
trap cleanup EXIT INT TERM

source_commit=$(git -C "$repository_root" rev-parse HEAD 2>/dev/null || printf 'unavailable')
if [[ -n $(git -C "$repository_root" status --porcelain 2>/dev/null || printf 'unknown') ]]; then
  source_dirty=true
else
  source_dirty=false
fi

docker run --rm --init --pull=missing --interactive --tty \
  --mount "type=bind,src=$repository_root,dst=/source,readonly" \
  --mount "type=bind,src=$output_directory,dst=/proof-output" \
  --env "SOMPI_PROOF_IMAGE=$image_reference" \
  --env "SOMPI_PROOF_SOURCE_COMMIT=$source_commit" \
  --env "SOMPI_PROOF_SOURCE_DIRTY=$source_dirty" \
  --env "SOMPI_PROOF_OUTPUT_UID=$(id -u)" \
  --env "SOMPI_PROOF_OUTPUT_GID=$(id -g)" \
  "$image_reference" \
  bash /source/test/human-present-authority/container-proof.sh

[[ -s "$output_directory/report.json" ]] || {
  echo "human-present authority proof produced no report" >&2
  exit 1
}
mkdir -p "$(dirname "$output_path")"
install -m 0600 "$output_directory/report.json" "$output_path"
echo "human-present authority proof passed: $output_path" >&2

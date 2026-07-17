#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 3 ]]; then
  echo "usage: test/human-present-live-testnet/run-container-proof.sh STATE_DIR SOURCE_WALLET_DIR OUTPUT.json" >&2
  exit 2
fi
if [[ ! -t 0 || ! -t 2 ]]; then
  echo "human-present funded proof requires an interactive terminal" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "human-present funded proof requires Docker" >&2
  exit 1
fi

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
state_directory=$(realpath -m -- "$1")
source_wallet_directory=$(realpath -- "$2")
output_path=$(realpath -m -- "$3")
readonly image_reference="node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94"

[[ -d "$source_wallet_directory" ]] || {
  echo "source wallet directory is unavailable" >&2
  exit 1
}
[[ "$state_directory" != "$source_wallet_directory" ]] || {
  echo "proof state and source wallet must be separate" >&2
  exit 1
}
[[ ! -e "$output_path" ]] || {
  echo "refusing to overwrite the human-present funded report" >&2
  exit 1
}
mkdir -p "$state_directory"
chmod 0700 "$state_directory"
output_directory=$(mktemp -d)
cleanup() {
  rm -rf "$output_directory"
}
trap cleanup EXIT INT TERM

source_commit=$(git -C "$repository_root" rev-parse HEAD)
if [[ -n $(git -C "$repository_root" status --porcelain) ]]; then
  echo "human-present funded proof requires a clean committed source tree" >&2
  exit 1
fi

docker run --rm --init --pull=missing --interactive --tty --network host \
  --mount "type=bind,src=$repository_root,dst=/source,readonly" \
  --mount "type=bind,src=$state_directory,dst=/proof-state" \
  --mount "type=bind,src=$source_wallet_directory,dst=/source-wallet,readonly" \
  --mount "type=bind,src=$output_directory,dst=/proof-output" \
  --env "SOMPI_PROOF_IMAGE=$image_reference" \
  --env "SOMPI_PROOF_SOURCE_COMMIT=$source_commit" \
  --env "SOMPI_PROOF_MCP_UID=$(id -u)" \
  --env "SOMPI_PROOF_MCP_GID=$(id -g)" \
  "$image_reference" \
  bash /source/test/human-present-live-testnet/container-proof.sh

[[ -s "$output_directory/report.json" ]] || {
  echo "human-present funded proof produced no report" >&2
  exit 1
}
mkdir -p "$(dirname "$output_path")"
install -m 0600 "$output_directory/report.json" "$output_path"
echo "human-present funded Testnet-10 proof passed: $output_path" >&2

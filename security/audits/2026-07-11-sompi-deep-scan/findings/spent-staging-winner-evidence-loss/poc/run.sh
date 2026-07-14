#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: sh run.sh <built-sompi-checkout>" >&2
  exit 2
fi

target=$(cd "$1" && pwd)
if [ ! -f "$target/dist/adapters/kaspa-x402/staging-recovery-rpc.js" ]; then
  echo "error: target is not built; run npm ci and npm run build first" >&2
  exit 2
fi

node reproduce.mjs "$target"

(
  cd "$target"
  node --test \
    --test-name-pattern='both candidates, partial evidence, unknown spenders' \
    dist/adapters/kaspa-x402/abandoned-staging-recovery.test.js
)
echo "[+] production classifier regression passed"

(
  cd "$target"
  node --test \
    --test-name-pattern='unknown staging spender fails closed' \
    dist/purchase/coordinator.test.js
)
echo "[+] coordinator regression confirmed failed_terminal with in_flight reservation"

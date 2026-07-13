#!/bin/sh
set -eu

target=${1:-${SOMPI_ROOT:-}}
if [ -z "$target" ]; then
  echo "usage: ./run.sh <path-to-built-sompi-checkout>" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_dir/poc.mjs" "$target"

#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Install Node.js 24 or newer from https://nodejs.org/ and run this file again.' >&2
  exit 1
fi
exec node scripts/start-local.js "$@"

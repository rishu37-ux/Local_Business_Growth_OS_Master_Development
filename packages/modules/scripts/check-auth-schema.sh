#!/usr/bin/env bash
# Drift check: after all migrations, Better Auth must need no schema changes.
# Fails when a Better Auth upgrade or plugin change needs a new migration.
set -euo pipefail
cd "$(dirname "$0")/.."
pending=$(../../scripts/with-throwaway-pg.sh sh -c 'node ../db/src/migrate-cli.ts >/dev/null && node scripts/generate-auth-schema.ts')
stripped=${pending//[[:space:];]/}   # with nothing pending the compiler prints a lone ";"
if [[ -n "$stripped" ]]; then
  echo "Better Auth schema drift — add a migration for:"
  echo "$pending"
  exit 1
fi
echo "ok      Better Auth schema matches migrations"

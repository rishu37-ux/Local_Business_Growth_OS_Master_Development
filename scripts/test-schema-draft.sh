#!/usr/bin/env bash
# Applies docs/data-model/schema_draft.sql to a throwaway PostgreSQL cluster and
# runs docs/data-model/schema_draft_test.sql against it. Synthetic data only.
# Any failed check stops psql, so exit status 0 means every check passed.
set -euo pipefail
cd "$(dirname "$0")/.."

scripts/with-throwaway-pg.sh bash -c '
  set -o pipefail
  echo "schema applied"
  psql -X -q -v ON_ERROR_STOP=1 -o /dev/null -f docs/data-model/schema_draft_test.sql 2>&1 \
    | sed "s/^psql:[^ ]* NOTICE:  /  /"
'

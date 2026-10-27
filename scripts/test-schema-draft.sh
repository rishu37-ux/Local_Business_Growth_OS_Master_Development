#!/usr/bin/env bash
# Applies docs/data-model/schema_draft.sql to a throwaway PostgreSQL cluster and
# runs docs/data-model/schema_draft_test.sql against it. Synthetic data only.
# The cluster is deleted on exit. Requires PostgreSQL server binaries (16+).
#
# Usage: scripts/test-schema-draft.sh
#   PG_BINDIR=/path/to/bin overrides binary discovery.
set -euo pipefail
cd "$(dirname "$0")/.."
repo=$(pwd)

bindir=${PG_BINDIR:-}
if [[ -z "$bindir" ]]; then
  if command -v pg_config >/dev/null && [[ -x "$(pg_config --bindir)/initdb" ]]; then
    bindir=$(pg_config --bindir)
  else
    bindir=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)
  fi
fi
[[ -x "$bindir/initdb" ]] || { echo "PostgreSQL server binaries not found (set PG_BINDIR)"; exit 2; }

work=$(mktemp -d)
port=${PGTEST_PORT:-54329}

# initdb refuses to run as root; use the postgres OS user in that case.
run() {
  if [[ $(id -u) -eq 0 ]]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

cleanup() {
  run "$bindir/pg_ctl" -D "$work/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

if [[ $(id -u) -eq 0 ]]; then
  chown postgres "$work"
fi

run "$bindir/initdb" -D "$work/data" -A trust -U postgres >/dev/null
run "$bindir/pg_ctl" -D "$work/data" -o "-p $port -k $work -c listen_addresses=''" -l "$work/log" -w start >/dev/null

psql_run() {
  run "$bindir/psql" -h "$work" -p "$port" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"
}

psql_run <<'SQL'
create role lbgos_owner nologin bypassrls;
create role lbgos_app nologin nobypassrls;
create role lbgos_platform nologin nobypassrls;
create extension pgcrypto;
create extension citext;
SQL

# psql running as the postgres OS user must be able to read the SQL files.
cat "$repo/docs/data-model/schema_draft.sql" | psql_run -f -
echo "schema applied"
set +e
cat "$repo/docs/data-model/schema_draft_test.sql" | psql_run -o /dev/null -f - 2>&1 | sed 's/^psql:[^ ]* NOTICE:  /  /'
status=${PIPESTATUS[1]}
set -e
exit "$status"

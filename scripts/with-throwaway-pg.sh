#!/usr/bin/env bash
# Starts a throwaway PostgreSQL cluster, runs packages/db/bootstrap/bootstrap.sql
# (roles, extensions), optionally applies the Phase 1 schema draft, then runs the
# given command with PGHOST/PGPORT/PGUSER/PGDATABASE exported. The cluster is
# deleted on exit and the command's exit status is returned. Synthetic data only.
#
# Usage: scripts/with-throwaway-pg.sh <command> [args...]
#   PGTEST_SCHEMA=draft applies docs/data-model/schema_draft.sql (default: none;
#   the command is expected to run migrations itself).
#   PG_BINDIR=/path/to/bin overrides binary discovery; PGTEST_PORT overrides the port.
set -euo pipefail
[[ $# -gt 0 ]] || { echo "usage: $0 <command> [args...]"; exit 2; }
repo=$(cd "$(dirname "$0")/.." && pwd)

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
as_pg() {
  if [[ $(id -u) -eq 0 ]]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

cleanup() {
  as_pg "$bindir/pg_ctl" -D "$work/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

if [[ $(id -u) -eq 0 ]]; then
  chown postgres "$work"
fi

as_pg "$bindir/initdb" -D "$work/data" -A trust -U postgres >/dev/null
as_pg "$bindir/pg_ctl" -D "$work/data" -o "-p $port -k $work -c listen_addresses=''" -l "$work/log" -w start >/dev/null

export PGHOST=$work PGPORT=$port PGUSER=postgres PGDATABASE=postgres
psql_q() { "$bindir/psql" -X -q -v ON_ERROR_STOP=1 "$@"; }

# LOGIN roles without passwords are acceptable only because the cluster listens
# on a private Unix socket and is deleted on exit.
psql_q -f "$repo/packages/db/bootstrap/bootstrap.sql"
if [[ "${PGTEST_SCHEMA:-none}" == "draft" ]]; then
  psql_q -f "$repo/docs/data-model/schema_draft.sql"
fi

set +e
PATH="$bindir:$PATH" "$@"
status=$?
set -e
exit "$status"

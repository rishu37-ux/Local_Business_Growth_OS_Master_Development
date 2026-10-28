#!/usr/bin/env bash
# Backup and restore drill (Phase 9.2, NFR-11, T20). Run inside a throwaway
# cluster:  scripts/with-throwaway-pg.sh scripts/backup-restore-drill.sh
# 1. migrates the source database and fills it with synthetic data by running
#    a few API test files against it (they leave their records behind);
# 2. takes a logical backup (pg_dump, custom format) and restores it into a new
#    database;
# 3. compares source and restore: applied migrations, row count of every table,
#    row-level security (enabled, forced, policies), table grants of the
#    application roles, and that tenant isolation still works for lbgos_app.
# Exits non-zero on any difference. Synthetic data only; nothing leaves the cluster.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
: "${PGHOST:?run inside scripts/with-throwaway-pg.sh}"
src=${PGDATABASE:-postgres}
dst=lbgos_restored
dump=$(mktemp -d)/lbgos.dump
q() { psql -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }

echo "== 1. migrate and seed (synthetic) =="
(cd "$repo/packages/db" && node src/migrate-cli.ts >/dev/null)
(cd "$repo/apps/api" && npx vitest run --config vitest.db.config.ts \
  test/campaigns.db.test.ts test/agents.db.test.ts test/analytics.db.test.ts >/dev/null)

echo "== 2. backup and restore =="
pg_dump -Fc -d "$src" -f "$dump"
echo "backup: $(du -h "$dump" | cut -f1)"
q -d "$src" -c "create database $dst"
pg_restore -d "$dst" --exit-on-error "$dump"

echo "== 3. compare =="
fail=0
check() { # name, query
  local a b
  a=$(q -d "$src" -c "$2")
  b=$(q -d "$dst" -c "$2")
  if [[ "$a" == "$b" ]]; then
    echo "PASS $1 ($(printf '%s\n' "$a" | wc -l) lines)"
  else
    echo "FAIL $1"
    diff <(printf '%s\n' "$a") <(printf '%s\n' "$b") | head -20 || true
    fail=1
  fi
}
check "applied migrations" "select name from lbg_migrations.kysely_migration order by name"
# Row count of every table in the application schemas, counted in each database.
counts="select string_agg(format('select %L as t, count(*) as n from %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname), ' union all ' order by n.nspname, c.relname)
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind = 'r' and n.nspname in ('lbg', 'auth')"
for db in "$src" "$dst"; do
  sqltext=$(q -d "$db" -c "$counts")
  q -d "$db" -c "select t || '=' || n from ($sqltext) x order by t" > "$dump.$db.counts"
done
if diff -q "$dump.$src.counts" "$dump.$dst.counts" >/dev/null; then
  echo "PASS row counts of $(wc -l < "$dump.$src.counts") tables ($(awk -F= '{s+=$2} END {print s}' "$dump.$src.counts") rows)"
else
  echo "FAIL row counts"; diff "$dump.$src.counts" "$dump.$dst.counts" | head -20 || true; fail=1
fi
check "row-level security" "select c.relname || ':' || c.relrowsecurity || ':' || c.relforcerowsecurity from pg_class c
  join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'lbg' and c.relkind = 'r' order by 1"
check "policies" "select tablename || ':' || policyname || ':' || array_to_string(roles, ',') from pg_policies where schemaname = 'lbg' order by 1"
check "grants" "select grantee || ':' || table_schema || '.' || table_name || ':' || privilege_type from information_schema.role_table_grants
  where grantee like 'lbgos_%' order by 1"
check "column grants" "select grantee || ':' || table_name || '.' || column_name || ':' || privilege_type from information_schema.column_privileges
  where grantee like 'lbgos_%' and table_schema = 'lbg' order by 1"
check "functions" "select p.proname || ':' || p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'lbg' order by 1"

# Tenant isolation in the restore: lbgos_app sees nothing without a business, and a business's own rows with it.
biz=$(q -d "$dst" -c "select business_id from lbg.customers group by business_id order by count(*) desc, business_id limit 1")
none=$(psql -X -q -t -A -U lbgos_app -d "$dst" -c "select count(*) from lbg.customers")
own_src=$(psql -X -q -t -A -U lbgos_app -d "$src" -c "begin; select set_config('app.business_id', '$biz', true); select count(*) from lbg.customers; commit;" | grep -E '^[0-9]+$' | tail -1)
own_dst=$(psql -X -q -t -A -U lbgos_app -d "$dst" -c "begin; select set_config('app.business_id', '$biz', true); select count(*) from lbg.customers; commit;" | grep -E '^[0-9]+$' | tail -1)
if [[ "$none" == "0" && "$own_src" == "$own_dst" && "$own_dst" -gt 0 ]]; then
  echo "PASS tenant isolation after restore (no context: 0 customers; business context: $own_dst in both)"
else
  echo "FAIL tenant isolation after restore (no context: $none; source $own_src; restore $own_dst)"; fail=1
fi

if [[ $fail -eq 0 ]]; then echo "DRILL PASSED"; else echo "DRILL FAILED"; fi
exit $fail

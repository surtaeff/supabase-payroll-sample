#!/usr/bin/env bash
# Runs the migrations and pgTAP tests against a throwaway local Postgres cluster.
# Needs Postgres 14+ binaries and the pgTAP extension installed.
# With the Supabase CLI the equivalent is: supabase db reset && supabase test db
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$(mktemp -d)"
PORT="${PGPORT_TEST:-54329}"
LOG="$DATA/postgres.log"

cleanup() {
  pg_ctl -D "$DATA/db" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$DATA"
}
trap cleanup EXIT

initdb -D "$DATA/db" -U postgres --auth=trust >/dev/null
pg_ctl -D "$DATA/db" -o "-p $PORT -k $DATA -c listen_addresses=''" -l "$LOG" -w start >/dev/null

PSQL=(psql -h "$DATA" -p "$PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)

"${PSQL[@]}" -f "$ROOT/scripts/supabase-stub.sql"
for migration in "$ROOT"/supabase/migrations/*.sql; do
  echo "migrate $(basename "$migration")"
  "${PSQL[@]}" -f "$migration"
done

failed=0
for test in "$ROOT"/supabase/tests/database/*.test.sql; do
  echo "test    $(basename "$test")"
  output="$("${PSQL[@]}" -t -A -f "$test" 2>&1)" || { echo "$output"; failed=1; continue; }
  if grep -Eq '^not ok|^# Looks like' <<<"$output"; then
    grep -E '^not ok|^#' <<<"$output"
    failed=1
  else
    echo "        $(grep -c '^ok' <<<"$output") ok"
  fi
done

exit "$failed"

#!/usr/bin/env bash
set -euo pipefail

VS=$(cd "$(dirname "$0")" && pwd)
OUT=${OUT:-$HOME/vs-results/$(date +%Y%m%d-%H%M%S)}
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
PGDATA=${PGDATA:-$HOME/vs-pg}
PGPORT=${PGPORT:-56491}
URL=postgres://postgres@127.0.0.1:$PGPORT/vs
PG_CPUS=${PG_CPUS:-16-31}
LOAD_CPUS=${LOAD_CPUS:-32-47}
GROUPS_N=${GROUPS_N:-10000}
CLIENTS=${CLIENTS:-10000}
SECONDS_PER_RUN=${SECONDS_PER_RUN:-15}
CONFIGS=${CONFIGS:-"rust1 rust8 lyn1 lyn8"}
SHARED_RATES=${SHARED_RATES:-"10 50 100 200 400 800"}
PRECISE_RATES=${PRECISE_RATES:-"200 1000 2000 5000 10000"}
SCENARIOS=${SCENARIOS:-"api page shared precise"}
mkdir -p "$OUT"
ulimit -n 1000000

if [ ! -d "$PGDATA" ]; then
  "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
fi
if ! "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  taskset -c "$PG_CPUS" "$PGBIN/pg_ctl" -D "$PGDATA" -l "$OUT/postgres.log" -o "-p $PGPORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp -c wal_level=logical -c max_connections=600 -c max_wal_senders=20 -c max_replication_slots=20 -c shared_buffers=4GB -c track_commit_timestamp=on" start >/dev/null
  sleep 2
fi
psql() { command psql -h 127.0.0.1 -p "$PGPORT" -U postgres "$@"; }
psql -tAc "select 1 from pg_database where datname = 'vs'" | grep -q 1 || psql -qc "create database vs"
psql -d vs -q -v groups="$GROUPS_N" -f "$VS/schema.sql" 2>/dev/null
PG_PID=$(head -1 "$PGDATA/postmaster.pid")

SERVER_PID=
start_server() {
  local config=$1
  case $config in
    rust1) DATABASE_URL=$URL PORT=4600 WORKERS=1 taskset -c 8 "$VS/target/release/vs-server" >>"$OUT/server.log" 2>&1 & ;;
    rust8) DATABASE_URL=$URL PORT=4600 WORKERS=8 taskset -c 8-15 "$VS/target/release/vs-server" >>"$OUT/server.log" 2>&1 & ;;
    lyn1) (cd "$VS/lyn" && DATABASE_URL=$URL PORT=4601 NODE_ENV=production exec taskset -c 8 node ${NODE_FLAGS:-} server.ts >>"$OUT/server.log" 2>&1) & ;;
    lyn8) (cd "$VS/lyn" && DATABASE_URL=$URL PORT=4601 NODE_ENV=production exec taskset -c 8-15 node ${NODE_FLAGS:-} server.ts >>"$OUT/server.log" 2>&1) & ;;
  esac
  SERVER_PID=$!
  ADDR=127.0.0.1:$([ "${config:0:4}" = rust ] && echo 4600 || echo 4601)
  TARGET=$([ "${config:0:4}" = rust ] && echo rust || echo lyn)
  for _ in $(seq 1 100); do curl -sf "http://$ADDR/api/items?grp=1" >/dev/null && return; sleep 0.2; done
  echo "server $config did not start" >&2
  exit 1
}
stop_server() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  sleep 1
}
load() {
  local config=$1
  shift
  taskset -c "$LOAD_CPUS" env WORKERS=16 "$VS/target/release/vs-load" --target "$TARGET" --addr "$ADDR" --server-pid "$SERVER_PID" --pg-pid "$PG_PID" "$@" \
    | python3 -c "import json,sys; r=json.loads(sys.stdin.read()); r['config']='$config'; print(json.dumps(r))" | tee -a "$OUT/results.jsonl"
}
overloaded() {
  python3 -c "import json,sys; r=json.loads(open('$OUT/results.jsonl').read().splitlines()[-1]); bad = r['deliveredShare'] < 0.95 or r['deliveryMs']['p99'] > 5000 or r['failedClients'] > 0 or r['writesFailed'] > 0 or r['achievedWritesPerSecond'] < 0.9 * r['rate']; sys.exit(0 if bad else 1)"
}

for config in $CONFIGS; do
  for scenario in $SCENARIOS; do
    case $scenario in
      api|page)
        start_server "$config"
        path=/api/items
        [ "$scenario" = page ] && path=$([ "$TARGET" = rust ] && echo /page || echo /)
        load "$config" --mode http --path "$path" --groups "$GROUPS_N" --concurrency 256 --seconds "$SECONDS_PER_RUN"
        stop_server
        ;;
      shared|precise)
        rates=$([ "$scenario" = shared ] && echo "$SHARED_RATES" || echo "$PRECISE_RATES")
        for rate in $rates; do
          start_server "$config"
          load "$config" --mode "$scenario" --clients "$CLIENTS" --groups "$GROUPS_N" --rate "$rate" --seconds "$SECONDS_PER_RUN"
          stop_server
          if overloaded; then break; fi
        done
        ;;
    esac
  done
done
echo "results: $OUT/results.jsonl"

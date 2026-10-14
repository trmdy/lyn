#!/bin/sh
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PGBIN=${PGBIN:-$(ls -d /opt/homebrew/opt/postgresql@18/bin /usr/lib/postgresql/18/bin 2>/dev/null | head -1)}
PGDATA="$ROOT/.pgdata"
PGPORT=${PGPORT:-54329}
DB=${DB:-lyn_todos}
LC_ALL=${LC_ALL:-en_US.UTF-8}
export PGDATA PGPORT LC_ALL

case "${1:-start}" in
  start)
    if [ ! -d "$PGDATA" ]; then
      "$PGBIN/initdb" -A trust -U postgres --locale=C -E UTF8 >/dev/null
      cat >> "$PGDATA/postgresql.conf" <<CONF
wal_level = logical
max_replication_slots = 20
max_wal_senders = 20
listen_addresses = 'localhost'
unix_socket_directories = '$PGDATA'
CONF
    fi
    "$PGBIN/pg_ctl" status >/dev/null 2>&1 || "$PGBIN/pg_ctl" -l "$PGDATA/server.log" -w start >/dev/null
    "$PGBIN/psql" -h localhost -U postgres -tAc "select 1 from pg_database where datname='$DB'" | grep -q 1 \
      || "$PGBIN/createdb" -h localhost -U postgres "$DB"
    echo "postgres://postgres@localhost:$PGPORT/$DB"
    ;;
  stop) "$PGBIN/pg_ctl" -m fast stop ;;
  psql) shift; exec "$PGBIN/psql" -h localhost -U postgres "$DB" "$@" ;;
  *) echo "usage: db.sh start|stop|psql" >&2; exit 1 ;;
esac

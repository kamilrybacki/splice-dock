#!/usr/bin/env bash
# Smoke-test a container image end to end on an isolated Docker network.
#
#   IMG=ghcr.io/kamilrybacki/splice-dock:v1.0.0 scripts/smoke/run-image.sh
#
# 1. SQLite: start the image with the Quickstart config and a data volume on a
#    network with no egress, run client.mjs, restart, check health again.
# 2. PostgreSQL: migrate that SQLite database into PostgreSQL 16, start two
#    gateways on the same database and run client.mjs against each.
# Fails on the first failed check or if a gateway logs an error.
set -euo pipefail

IMG="${IMG:?set IMG to the image to test}"
# Same image as the CI test service. The password is a fixed test literal for
# this disposable container, not a secret.
PG_IMG=postgres:16-alpine@sha256:e0e53cfa0884f3cc216a621033e4f38dceb49e52218ac77facc8e48f02973093
PG_PASSWORD=splicedock-smoke-throwaway
PREFIX="${SMOKE_PREFIX:-sd-smoke}"
NET="$PREFIX-net"
VOLUME="$PREFIX-data"
GATEWAYS=("$PREFIX-sqlite" "$PREFIX-pg1" "$PREFIX-pg2")
PG="$PREFIX-pg"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config="$(cd "$here/../.." && pwd)/site/examples/quickstart.yaml"
client="$here/client.mjs"
admin_token="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
dsn="postgres://postgres:${PG_PASSWORD}@${PG}:5432/postgres"

cleanup() {
  docker rm -f "${GATEWAYS[@]}" "$PG" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
docker network create --internal "$NET" >/dev/null

start_gateway() { # name, extra docker args...
  local name="$1"
  shift
  docker run -d --name "$name" --network "$NET" \
    -e SPLICEDOCK_ADMIN_TOKEN="$admin_token" \
    -v "$config:/etc/splicedock/splicedock.yaml:ro" \
    "$@" "$IMG" >/dev/null
}

run_client() { # name
  local name="$1"
  docker cp "$client" "$name:/app/smoke-client.mjs"
  if ! docker exec -e SPLICEDOCK_ADMIN_TOKEN="$admin_token" "$name" node /app/smoke-client.mjs; then
    docker logs "$name" 2>&1 | tail -40 >&2
    exit 1
  fi
}

wait_healthy() { # name
  local name="$1"
  for _ in $(seq 150); do
    if docker exec "$name" node -e 'fetch("http://127.0.0.1:8789/api/v1/health").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))' 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  echo "$name did not become healthy" >&2
  docker logs "$name" 2>&1 | tail -40 >&2
  exit 1
}

echo "## SQLite: $IMG on an internal network"
start_gateway "${GATEWAYS[0]}" -v "$VOLUME:/var/splicedock/data"
run_client "${GATEWAYS[0]}"
docker restart "${GATEWAYS[0]}" >/dev/null
wait_healthy "${GATEWAYS[0]}"
echo "PASS healthy after restart"
docker stop "${GATEWAYS[0]}" >/dev/null

echo "## PostgreSQL: migrate the SQLite database"
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD="$PG_PASSWORD" "$PG_IMG" >/dev/null
for _ in $(seq 60); do
  docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker run --rm --network "$NET" -e SPLICEDOCK_DB_DSN="$dsn" \
  -v "$VOLUME:/var/splicedock/data" --entrypoint node "$IMG" \
  /app/dist/main.js db migrate-sqlite-to-pg --sqlite /var/splicedock/data/splicedock.db

for name in "${GATEWAYS[1]}" "${GATEWAYS[2]}"; do
  echo "## PostgreSQL: gateway $name"
  start_gateway "$name" -e SPLICEDOCK_DB_DSN="$dsn"
  run_client "$name"
  logs="$(docker logs "$name" 2>&1)"
  if [[ "$logs" != *'"backend":"postgres"'* ]]; then
    echo "$name did not open the PostgreSQL backend" >&2
    exit 1
  fi
done

echo "## Gateway logs"
errors=0
for name in "${GATEWAYS[@]}"; do
  count="$(docker logs "$name" 2>&1 | grep -c '"level":"error"' || true)"
  echo "$name: $count error lines"
  if [ "$count" -ne 0 ]; then
    docker logs "$name" 2>&1 | grep '"level":"error"' >&2
    errors=1
  fi
done
[ "$errors" -eq 0 ]
echo "SMOKE PASS"

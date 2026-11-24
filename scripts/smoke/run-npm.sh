#!/usr/bin/env bash
# Smoke-test the npm package the way a bare-metal user installs it.
#
#   scripts/smoke/run-npm.sh            # packs the checkout (runs the build)
#   TARBALL=splicedock-1.0.0.tgz scripts/smoke/run-npm.sh
#
# Installs the tarball globally in a fresh node:22-slim container, starts
# `splicedock` with the Quickstart config shipped in the package, then runs
# site/examples/first-call.mjs and client.mjs against it. The container needs
# registry access to install the package's dependencies.
set -euo pipefail

NODE_IMG="${NODE_IMG:-node:22-slim}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ -n "${TARBALL:-}" ]; then
  cp "$TARBALL" "$work/splicedock.tgz"
else
  (cd "$repo" && npm pack --silent --pack-destination "$work" >/dev/null)
  mv "$work"/splicedock-*.tgz "$work/splicedock.tgz"
fi
cp "$here/client.mjs" "$work/client.mjs"
admin_token="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"

docker run --rm -v "$work:/smoke:ro" -e SPLICEDOCK_ADMIN_TOKEN="$admin_token" "$NODE_IMG" bash -euo pipefail -c '
  npm install -g --no-fund --no-audit /smoke/splicedock.tgz >/tmp/install.log 2>&1 || { cat /tmp/install.log >&2; exit 1; }
  pkg="$(npm root -g)/splicedock"
  echo "PASS installed splicedock $(node -p "require(\"$pkg/package.json\").version")"
  data="$(mktemp -d)"
  export SPLICEDOCK_CONFIG="$pkg/site/examples/quickstart.yaml" SPLICEDOCK_DB_PATH="$data/splicedock.db"
  splicedock >"$data/gateway.log" 2>&1 &
  gateway=$!
  trap "kill $gateway 2>/dev/null || true" EXIT
  cp /smoke/client.mjs "$pkg/smoke-client.mjs"
  node "$pkg/site/examples/first-call.mjs" || { cat "$data/gateway.log" >&2; exit 1; }
  echo "PASS first-call.mjs"
  node "$pkg/smoke-client.mjs" || { cat "$data/gateway.log" >&2; exit 1; }
  if grep "\"level\":\"error\"" "$data/gateway.log" >&2; then echo "gateway logged errors" >&2; exit 1; fi
  usage="$(splicedock db 2>&1 || true)"
  case "$usage" in *migrate-sqlite-to-pg*) ;; *) echo "splicedock db usage is missing migrate-sqlite-to-pg: $usage" >&2; exit 1 ;; esac
  echo "PASS splicedock db usage"
'
echo "NPM SMOKE PASS"

#!/usr/bin/env bash
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../" && pwd)"
seed_file="$repo_root/openbot/server/tests/fixtures/odoo20-qualification-seed.py"
private_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/scout-odoo20-qualification.XXXXXXXX")"
suffix="$(openssl rand -hex 8)"
network="scout-odoo20-$suffix"
pg_name="scout-odoo20-pg-$suffix"
init_name="scout-odoo20-init-$suffix"
seed_name="scout-odoo20-seed-$suffix"
app_name="scout-odoo20-app-$suffix"
database="scout_qualification"
pg_password="$(openssl rand -hex 32)"

odoo_image="odoo:20.0-20261015@sha256:d5e3a26baa044867c826dddc09058f10e2582706bf83c146ea04fea889720c76"
postgres_image="postgres:16.10-bookworm@sha256:38471f330eb885e04de130b768d6db4e10469e2311879c7e5c699f6d2d8a1c74"

cleanup() {
  docker rm -fv "$app_name" "$seed_name" "$init_name" "$pg_name" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf -- "$private_dir"
}
trap cleanup EXIT INT TERM

fail_step() {
  printf 'Odoo 20 qualification setup failed at %s (exit %s); private logs were withheld.\n' "$1" "$2" >&2
  exit "$2"
}

docker network create "$network" >/dev/null
docker run --platform linux/amd64 --detach --name "$pg_name" \
  --network "$network" --network-alias pg \
  --health-cmd='pg_isready -U odoo -d postgres' --health-interval=2s \
  --health-timeout=3s --health-retries=60 \
  --env POSTGRES_USER=odoo --env "POSTGRES_PASSWORD=$pg_password" \
  --env POSTGRES_DB=postgres "$postgres_image" >/dev/null

pg_ready=false
for attempt in $(seq 1 90); do
  if docker exec "$pg_name" pg_isready -U odoo -d postgres >/dev/null 2>&1; then
    pg_ready=true
    break
  fi
  sleep 2
done
if [[ "$pg_ready" != true ]]; then
  fail_step postgres-readiness 1
fi

if ! docker create --platform linux/amd64 --name "$init_name" --network "$network" \
  --env HOST=pg --env PORT=5432 --env USER=odoo --env "PASSWORD=$pg_password" \
  "$odoo_image" -d "$database" --init=base,project,portal --without-demo=all \
  --stop-after-init --workers=0 --max-cron-threads=0 \
  --db_host=pg --db_port=5432 --db_user=odoo --db_password="$pg_password" \
  >/dev/null; then
  fail_step database-initialization 1
fi
if ! docker start --attach "$init_name" >"$private_dir/odoo-init.log" 2>&1; then
  fail_step database-initialization 1
fi
docker rm -fv "$init_name" >/dev/null

if ! docker create --platform linux/amd64 --name "$seed_name" --network "$network" \
  --env HOST=pg --env PORT=5432 --env USER=odoo --env "PASSWORD=$pg_password" \
  "$odoo_image" odoo shell -d "$database" --no-http --db_host=pg --db_port=5432 \
  --db_user=odoo --db_password="$pg_password" >/dev/null; then
  fail_step seed-container-create 1
fi
if ! docker start --attach --interactive "$seed_name" \
  < "$seed_file" >"$private_dir/odoo-seed.log" 2>&1; then
  fail_step fixture-seeding 1
fi
mkdir -m 700 "$private_dir/fixture"
if ! docker cp "$seed_name:/tmp/scout-odoo20-qualification/credentials.json" \
  "$private_dir/fixture/credentials.json" >/dev/null 2>&1 || \
  ! docker cp "$seed_name:/tmp/scout-odoo20-qualification/metadata.json" \
  "$private_dir/fixture/metadata.json" >/dev/null 2>&1; then
  fail_step fixture-readback 1
fi
chmod 600 "$private_dir/fixture/credentials.json" "$private_dir/fixture/metadata.json"
docker rm -fv "$seed_name" >/dev/null

docker run --platform linux/amd64 --detach --name "$app_name" --network "$network" \
  --publish 127.0.0.1::8069 --env HOST=pg --env PORT=5432 --env USER=odoo \
  --env PASSWORD="$pg_password" "$odoo_image" -d "$database" \
  --db_host=pg --db_port=5432 --db_user=odoo --db_password="$pg_password" \
  --db-filter="^${database}$" --no-database-list --workers=0 \
  --max-cron-threads=0 >/dev/null
host_port="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8069/tcp") 0).HostPort}}' "$app_name")"
base_url="http://127.0.0.1:$host_port"

odoo_ready=false
for attempt in $(seq 1 120); do
  if curl --fail --silent --show-error --max-time 3 "$base_url/web/version" \
    >"$private_dir/version.json" 2>/dev/null; then
    odoo_ready=true
    break
  fi
  sleep 2
done
if [[ "$odoo_ready" != true ]]; then
  fail_step odoo-http-readiness 1
fi

export SCOUT_ODOO20_BASE_URL="$base_url"
export SCOUT_ODOO20_FIXTURE_FILE="$private_dir/fixture/metadata.json"
export SCOUT_ODOO20_CREDENTIALS_FILE="$private_dir/fixture/credentials.json"
export SCOUT_ODOO20_REPORT_FILE="$private_dir/qualification-report.json"
export SCOUT_ODOO20_IMAGE_REF="$odoo_image"

cd "$repo_root/openbot"
if ! bun test server/tests/odoo20-context-qualification.integration.test.ts \
  >"$private_dir/bun-test.log" 2>&1; then
  # Bun's summary contains no fixture secrets. Forward only its final test status,
  # while keeping complete runner logs private and ephemeral.
  tail -n 25 "$private_dir/bun-test.log" >&2
  exit 1
fi
cat "$private_dir/qualification-report.json"
printf 'Real Odoo 20 Community JSON-2 qualification passed against pinned official images.\n'

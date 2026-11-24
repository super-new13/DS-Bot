#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root. --config-only renders without contacting Docker Engine.
[[ $# -eq 0 || ( $# -eq 1 && $1 == --config-only ) ]] || exit 2
[[ -f compose.enterprise.yml && -f docker/enterprise-policy-smoke.mjs ]] || exit 2
umask 077
scratch=$(mktemp -d /tmp/dsbot-policy-smoke.XXXXXXXX)
export DSBOT_FILE_POLICY_CONFIG_DIR="$scratch/policy" DSBOT_WORKER_CONFIG_DIR="$scratch/worker"
started=0
compose() {
  docker compose --env-file /dev/null -p "$project" -f compose.enterprise.yml -f "$scratch/fixture.json" "$@"
}
cleanup() {
  local rc=$?
  trap - EXIT
  trap '' HUP INT TERM
  if [[ $started == 1 ]]; then
    if ! compose --profile file-policy --profile worker --profile smoke down --volumes --remove-orphans; then
      printf 'Cleanup failed for disposable project %s. Retry its Compose down command with %s/fixture.json.\n' "$project" "$scratch" >&2
      exit 1
    fi
    docker image rm "$project:local" >/dev/null 2>&1 || true
  fi
  [[ $scratch == /tmp/dsbot-policy-smoke.???????? && -d $scratch ]] && rm -rf -- "$scratch"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
project=dsbot-policy-smoke-$(openssl rand -hex 8)
mkdir "$scratch"/{policy,worker,controller,ca}
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=Disposable smoke CA' \
  -keyout "$scratch/ca/key.pem" -out "$scratch/ca/ca.pem" >"$scratch/openssl.log" 2>&1
issue() {
  local name=$1 dir=$2 extensions=$3
  printf '%s\n' "$extensions" > "$scratch/ca/extensions"
  openssl req -new -newkey rsa:2048 -nodes -subj "/CN=$name" \
    -keyout "$dir/$name.key" -out "$scratch/ca/request" >>"$scratch/openssl.log" 2>&1
  openssl x509 -req -in "$scratch/ca/request" -CA "$scratch/ca/ca.pem" -CAkey "$scratch/ca/key.pem" \
    -CAcreateserial -days 1 -extfile "$scratch/ca/extensions" -out "$dir/$name.pem" >>"$scratch/openssl.log" 2>&1
}
issue policy "$scratch/policy" $'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:file-policy'
issue worker-server "$scratch/worker" $'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:worker'
issue reservation-client "$scratch/worker" 'extendedKeyUsage=clientAuth'
issue producer "$scratch/worker" 'extendedKeyUsage=clientAuth'
issue controller "$scratch/controller" 'extendedKeyUsage=clientAuth'
for role in policy worker controller; do
  cp "$scratch/ca/ca.pem" "$scratch/$role/ca.pem"
  cp docker/enterprise-policy-smoke.mjs "$scratch/$role/$role.mjs"
  # The private host scratch directory keeps these ephemeral files off-limits
  # to other users while UID 1000 can read the mounted role directory.
  chmod 755 "$scratch/$role"
  chmod 644 "$scratch/$role/"*
done
cp "$scratch/worker/reservation-client.pem" "$scratch/worker/producer.pem" "$scratch/policy/"
cp "$scratch/controller/controller.pem" "$scratch/worker/"
chmod 644 "$scratch/policy/"*.pem "$scratch/worker/controller.pem"
cat > "$scratch/fixture.json" <<JSON
{"services":{
  "file-policy":{"image":"$project:local","healthcheck":{"test":["CMD","node","/app/config/policy.mjs","ready"],"interval":"1s","timeout":"3s","retries":30}},
  "worker":{"image":"$project:local","healthcheck":{"test":["CMD","node","/app/config/worker.mjs","ready"],"interval":"1s","timeout":"3s","retries":30}},
  "smoke-controller":{"profiles":["smoke"],"image":"$project:local","pull_policy":"never","user":"1000:1000","read_only":true,"cap_drop":["ALL"],"networks":["file-operations"],"entrypoint":["node","/app/config/controller.mjs","submit"],"volumes":[{"type":"bind","source":"$scratch/controller","target":"/app/config","read_only":true,"bind":{"create_host_path":false}}]}
}}
JSON
compose --profile file-policy --profile worker --profile smoke config --format json | python3 -c '
import json, sys
m = json.load(sys.stdin)
assert m["networks"]["file-operations"]["internal"]
for role in ("file-policy", "worker", "smoke-controller"):
    s = m["services"][role]
    assert not s.get("ports") and not s.get("network_mode")
    assert list(s["networks"]) == ["file-operations"]
    assert s["volumes"][0]["read_only"]
assert not m["services"]["dsh"].get("ports")
print("Rendered roles use a private network and publish zero ports")'
[[ $# == 0 ]] || exit 0
docker version --format '{{.Server.Version}}'
started=1
compose build file-policy
compose up -d --no-build --wait --wait-timeout 45 file-policy worker
compose run --rm --no-deps smoke-controller
compose exec -T worker node /app/config/worker.mjs verify-write
compose exec -T file-policy node /app/config/policy.mjs revoke-pending
compose exec -T worker node /app/config/worker.mjs verify-pending
compose exec -T worker node /app/config/worker.mjs drain
compose exec -T file-policy node /app/config/policy.mjs revoke-complete
compose exec -T worker node /app/config/worker.mjs verify-settled
printf 'Guarded write, pending revocation, credential separation, and exact settlement passed.\n'

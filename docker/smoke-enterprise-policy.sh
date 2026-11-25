#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root. --config-only checks the generated fixture without Docker.
set +x
employee=0
config_only=0
for option in "$@"; do
  case "$option" in
    --employee) employee=1 ;;
    --config-only) config_only=1 ;;
    *) printf 'Usage: %s [--employee] [--config-only]\n' "$0" >&2; exit 2 ;;
  esac
done
[[ -f compose.enterprise.yml && -f docker/enterprise-policy-smoke.mjs ]] || exit 2
umask 077
scratch=$(mktemp -d /tmp/dsbot-policy-smoke.XXXXXXXX)
export DSBOT_FILE_POLICY_CONFIG_DIR="$scratch/policy" DSBOT_WORKER_CONFIG_DIR="$scratch/worker"
started=0
extra_files=()
extra_profiles=()
if [[ $employee == 1 ]]; then
  extra_files=(-f "$scratch/employee-ports.yml")
  extra_profiles=(--profile employee-pilot)
fi
compose() {
  docker compose --env-file /dev/null -p "$project" -f compose.enterprise.yml -f "$scratch/fixture.json" ${extra_files[@]+"${extra_files[@]}"} "$@"
}
cleanup() {
  local rc=$?
  trap - EXIT
  trap '' HUP INT TERM
  if [[ $started == 1 ]]; then
    if ! compose --profile file-policy --profile worker --profile smoke ${extra_profiles[@]+"${extra_profiles[@]}"} down --volumes --remove-orphans; then
      printf 'Cleanup failed for disposable project %s. Retry its Compose down command with the overlays in %s.\n' "$project" "$scratch" >&2
      exit 1
    fi
    docker image rm "$project:local" >/dev/null 2>&1 || true
    if [[ $employee == 1 ]]; then docker image rm "$project:employee" >/dev/null 2>&1 || true; fi
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
if [[ $employee == 1 ]]; then
  mkdir "$scratch/employee" "$scratch/rules"
  # All containers use UID 1000. The host scratch parent remains mode 0700.
  chmod 777 "$scratch/rules"
  export DSBOT_ENTERPRISE_CONFIG_DIR="$scratch/employee"
  issue employee "$scratch/employee" $'extendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1'
  cp "$scratch/controller/controller.pem" "$scratch/controller/controller.key" "$scratch/ca/ca.pem" "$scratch/employee/"
  cp docker/enterprise-policy-smoke.mjs "$scratch/employee/employee.mjs"
  cp docker/enterprise-employee-smoke.py "$scratch/employee/entry-smoke.py"
  chmod 755 "$scratch/employee"
  chmod 644 "$scratch/employee/"*
  employee_port=$(python3 - "$scratch" "$project" <<'PYCONFIG'
import hashlib
import json
import pathlib
import secrets
import socket
import sys

scratch = pathlib.Path(sys.argv[1])
project = sys.argv[2]
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
mount = "/run/dsbot-enterprise/"
token = secrets.token_urlsafe(32)
(scratch / "owner-token").write_text(token + "\n")
config = dict(initializeAccounts=True, owner=dict(tokenHash=hashlib.sha256(token.encode()).hexdigest(),
    transcriptDirectory="/home/node/smoke-transcripts", ruleFile="/run/dsbot-smoke-rules/rules.json", initializeRules=True), accountFile="/home/node/smoke-accounts.json", https=dict(
    host="0.0.0.0", port=8443, origin=f"https://127.0.0.1:{port}",
    certFile=mount + "employee.pem", keyFile=mount + "employee.key"),
    workers=[dict(nodeId="node", origin="https://worker:9445", caFile=mount + "ca.pem",
                  certFile=mount + "controller.pem", keyFile=mount + "controller.key")],
    limits=dict(maxActive=1, maxPerBot=1, maxPerNode=1, maxPending=2),
    roster=dict(people={"alice": dict(id="alice", name="Alice", botIds=["helper"])},
                bots={"helper": dict(id="helper", nodeId="node")}, rooms={}))
config_path = scratch / "employee/config.json"
config_path.write_text(json.dumps(config))
config_path.chmod(0o644)
fixture = scratch / "fixture.json"
model = json.loads(fixture.read_text())
model["services"]["worker"]["environment"] = {"DSBOT_SMOKE_EMPLOYEE": "1"}
model["services"]["employee-pilot"] = dict(image=project + ":employee", networks=["file-operations"],
    healthcheck=dict(test=["CMD", "node", mount + "employee.mjs", "employee-ready"], interval="1s", timeout="3s", retries=30))
# Mount the directory so readers see subsequent atomic replacements.
for service in ("employee-pilot", "file-policy", "worker"):
    target = model["services"][service]
    target.setdefault("volumes", []).append(dict(type="bind", source=str(scratch / "rules"),
        target="/run/dsbot-smoke-rules", read_only=service != "employee-pilot", bind=dict(create_host_path=False)))
    if service != "employee-pilot":
        target.setdefault("environment", {})["DSBOT_SMOKE_OWNER"] = "1"
fixture.write_text(json.dumps(model))
# An override replaces the default pilot port instead of adding another mapping.
(scratch / "employee-ports.yml").write_text(f'services:\n  employee-pilot:\n    ports: !override ["127.0.0.1:{port}:8443"]\n')
print(port)
PYCONFIG
  )
fi
if [[ $config_only == 1 ]]; then
  python3 - "$scratch" "$employee" <<'PYCHECK'
import hashlib
import json
import pathlib
import sys

scratch = pathlib.Path(sys.argv[1])
services = json.loads((scratch / "fixture.json").read_text())["services"]
assert all(not service.get("ports") for service in services.values())
if sys.argv[2] == "1":
    owner = json.loads((scratch / "employee/config.json").read_text())["owner"]
    digest = hashlib.sha256((scratch / "owner-token").read_text().strip().encode()).hexdigest()
    assert owner == dict(tokenHash=digest, transcriptDirectory="/home/node/smoke-transcripts",
                         ruleFile="/run/dsbot-smoke-rules/rules.json", initializeRules=True)
    for name in ("employee-pilot", "file-policy", "worker"):
        volume, = services[name]["volumes"]
        assert volume["source"] == str(scratch / "rules") and volume["target"] == "/run/dsbot-smoke-rules"
        assert volume["read_only"] == (name != "employee-pilot")
    assert services["employee-pilot"]["networks"] == ["file-operations"]
    assert (scratch / "owner-token").stat().st_mode & 0o077 == 0
print("Disposable smoke configuration passed")
PYCHECK
  exit 0
fi
compose --profile file-policy --profile worker --profile smoke ${extra_profiles[@]+"${extra_profiles[@]}"} config --format json | python3 -c '
import json, sys
m = json.load(sys.stdin)
assert m["networks"]["file-operations"]["internal"]
for role in ("file-policy", "worker", "smoke-controller"):
    s = m["services"][role]
    assert not s.get("ports") and not s.get("network_mode")
    assert list(s["networks"]) == ["file-operations"]
    assert all(v["read_only"] for v in s["volumes"] if v["type"] == "bind")
assert not m["services"]["dsh"].get("ports")
if "employee-pilot" in m["services"]:
    entry = m["services"]["employee-pilot"]
    port, = entry["ports"]
    assert port["host_ip"] == "127.0.0.1" and port["target"] == 8443
    assert str(port["published"]) == sys.argv[1]
    assert set(entry["networks"]) == {"employee-edge", "file-operations"}
    for role in ("file-policy", "worker", "employee-pilot"):
        mount, = [v for v in m["services"][role]["volumes"] if v["target"] == "/run/dsbot-smoke-rules"]
        # Compose omits read_only for a writable mount, and may drop bind options.
        assert mount.get("read_only", False) == (role != "employee-pilot")
    print("Employee HTTPS is the only published port and binds to loopback")
else:
    print("Rendered roles use a private network and publish zero ports")' "${employee_port:-}"
docker version --format '{{.Server.Version}}'
started=1
compose build file-policy
if [[ $employee == 1 ]]; then
  compose build employee-pilot
  compose run --rm -T --no-deps --entrypoint node employee-pilot \
    -e 'require("node:fs").mkdirSync("/home/node/smoke-transcripts", {mode: 0o700})'
  compose up -d --no-build --wait --wait-timeout 45 employee-pilot
fi
compose up -d --no-build --wait --wait-timeout 45 file-policy worker
if [[ $employee == 1 ]]; then
  compose exec -T employee-pilot python3 /run/dsbot-enterprise/entry-smoke.py "$employee_port" \
    < "$scratch/owner-token" > "$scratch/request-id"
  rm -- "$scratch/owner-token"
  { IFS= read -r request_id; IFS= read -r denied_request_id; } < "$scratch/request-id"
  compose exec -T worker node /app/config/worker.mjs verify-write "$request_id" "$denied_request_id"
else
  compose run --rm --no-deps smoke-controller
  request_id=fixture-request
  compose exec -T worker node /app/config/worker.mjs verify-write "$request_id"
fi
compose exec -T file-policy node /app/config/policy.mjs revoke-pending
compose exec -T worker node /app/config/worker.mjs verify-pending
compose exec -T worker node /app/config/worker.mjs drain
compose exec -T file-policy node /app/config/policy.mjs revoke-complete "$request_id"
compose exec -T worker node /app/config/worker.mjs verify-settled
printf 'Guarded write, pending revocation, credential separation, and exact settlement passed.\n'

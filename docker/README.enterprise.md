# Enterprise Compose foundation

This opt-in fixture starts the existing DSH image with DS Bot installed. The
admin listener binds to container loopback, and Compose publishes zero ports.
The default fixture requires no Relay configuration. Enable the employee
HTTPS pilot separately as described below.

## Validate locally

Run from the repository root. Use the enterprise file on its own. Merging it
with a legacy Compose file can start the legacy service with its published
admin port and host data mounts.

```sh
node --test docker/test-enterprise.mjs
docker compose --env-file /dev/null -f compose.enterprise.yml config --quiet
```

For a startup smoke test, use a local Docker engine and a fresh project name.
The test checks that DSH responds over HTTP inside the container. It needs no
model credentials and exercises no turns. The build may fetch public packages.
The running container has no external network route.

```sh
project="ds-bot-enterprise-smoke-$(date +%s)-$$"
docker compose --env-file /dev/null -f compose.enterprise.yml -p "$project" up --build --wait
docker compose --env-file /dev/null -f compose.enterprise.yml -p "$project" ps
docker compose --env-file /dev/null -f compose.enterprise.yml -p "$project" down --volumes
```

Compose scopes both named volumes to this project. The image seeds a fresh
profile at `/data` and starts it with a separate `/workspace`. Keep existing DSH
homes, Docker data, host workspaces and credentials out of this fixture. Use
`down --volumes` only for disposable projects. DSH startup logs can include a
login bootstrap credential, so keep them out of test evidence.

## Integrate the enterprise service

The intended production path is **browser → HTTPS ingress → enterprise
Web/API → authenticated DS Bot adapter**. The ingress should publish only the
employee site and same-origin API, including SSE. Put ingress and Web/API on a
separate edge network. Attach Web/API and the DSH adapter to
`enterprise-backend`. Keep the ingress off that network. The Web/API service
and adapter require no host ports. A production admin access path needs its own
private network or SSH tunnel.

The Web/API service derives employee identity from its server-side login
session and authenticates to a dedicated plugin adapter. The adapter accepts
only the approved business operations and rechecks employee and resource
scope. The pilot uses mutual TLS to authenticate the dedicated worker connection. Network membership alone grants
no authority. Do not forward DSH admin URLs, generic plugin channels, or
employee-supplied identity headers. Supply deployment credentials out of band.

The existing image uses the full-access container preset. Keep employee access
disabled until a runtime configuration enforces the approved tool and data
boundaries. Future acceptance includes mock-model login, chat, SSE and
revocation, validation of admin isolation, and backup and restore of accounts,
authorizations, conversations, audits and business files.

## Opt-in employee HTTPS pilot

Run from the repository root with a local Docker engine and a fresh Compose
project. The pilot publishes `https://127.0.0.1:18443` on host loopback. Compose
runs the packaged employee launcher as UID 1000 with a read-only root filesystem.

Put `config.json` and its TLS files in a dedicated host directory outside the
build context. The directory must already exist and be readable by container
UID 1000. Restrict private-key access to the operator and that UID. Compose
mounts the directory read-only at `/run/dsbot-enterprise`. Use absolute container
paths in the configuration. This example starts the page and account service
with chat disabled.

```json
{
  "accountFile": "/home/node/accounts.json",
  "initializeAccounts": true,
  "https": {
    "origin": "https://127.0.0.1:18443",
    "host": "0.0.0.0",
    "port": 8443,
    "certFile": "/run/dsbot-enterprise/employee.pem",
    "keyFile": "/run/dsbot-enterprise/employee.key"
  },
  "workers": [],
  "roster": {
    "people": { "pilot-alice": { "id": "pilot-alice", "name": "Alice", "botIds": [] } },
    "bots": {},
    "rooms": {}
  },
  "limits": { "maxActive": 1, "maxPerBot": 1, "maxPerNode": 1, "maxPending": 2 }
}
```

Use a server certificate with an IP subject alternative name for `127.0.0.1`
and a CA trusted by the pilot browser. Chat requires a separate mock mTLS
worker reachable from `employee-edge`. Its certificate must match its HTTPS
hostname and its grants must authorize the controller certificate for the test
employee and Bot. Add a `workers` entry with `nodeId`, canonical HTTPS `origin`
and absolute `caFile`, `certFile` and `keyFile` paths for the worker CA and
controller identity. Add a matching Bot under `roster.bots` with `id` and `nodeId`
and list its ID in the employee's `botIds`. Keep `rooms` empty. Use disposable
data and a mock model. Select only `employee-pilot` when starting the service.

```sh
export DSBOT_ENTERPRISE_CONFIG_DIR=/absolute/path/to/disposable-pilot-config
project="ds-bot-employee-smoke-$(date +%s)-$$"
pilot_compose() {
  docker compose --env-file /dev/null -f compose.enterprise.yml \
    --profile employee-pilot -p "$project" "$@"
}
pilot_compose config --quiet
pilot_compose up --build -d --no-deps employee-pilot
```

After the page responds over HTTPS, set `initializeAccounts` to `false` or
remove the key. Future starts will require the existing account store. Compose
mounts the project-scoped `enterprise-employee-data` volume at `/home/node`.
Keep that volume and project name across starts. The DSH fixture uses separate
volumes.

### Disposable Compose acceptance

Run these commands from the repository root. Both generate fresh TLS files and
a temporary pilot configuration. The first validates the rendered Compose
model without an engine. The second builds and starts a fresh project on a
local Docker engine. It needs OpenSSL, Docker Compose and a free loopback port
18443. The build may fetch public packages.

```sh
node docker/test-enterprise-smoke.mjs --config-only
node docker/test-enterprise-smoke.mjs --run
```

The runtime check verifies the pilot page, JavaScript and unauthenticated
session endpoint using the fixture certificate. It checks that the pilot is
the project's only container and publishes only loopback HTTPS. The fixture
has an empty roster and worker list. For mock chat coverage, run the employee
bootstrap test with its disposable mTLS worker.

```sh
node --test ds-bot/test/enterprise-employee-bootstrap.test.js
```

The command removes the temporary project and its volumes on completion.
An unavailable Docker engine is reported as BLOCKED with exit code 77.

### Issue an invitation or revoke an account

Stop the employee service and every other writer before starting the offline
admin command. Keep them stopped until it finishes. `--service-stopped` is the
operator's confirmation of exclusive access. The store has no cross-process
lock. Use the same project, image, config and account volume as the pilot.

```sh
account_volume="$project"_enterprise-employee-data
pilot_admin() {
  pilot_compose stop employee-pilot &&
    docker volume inspect "$account_volume" >/dev/null &&
    docker run --rm --pull=never --network=none --log-driver=none \
      --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
      --mount "type=bind,source=$DSBOT_ENTERPRISE_CONFIG_DIR,target=/run/dsbot-enterprise,readonly" \
      --mount "type=volume,source=$account_volume,target=/home/node" \
      --entrypoint node ds-bot-enterprise-dsh:local \
      /opt/dsh-template/profiles/web/node_modules/ds-bot/bin/ds-bot-enterprise-admin.mjs \
      --config /run/dsbot-enterprise/config.json --service-stopped "$@"
}
```

Capture invitation output privately. The helper disables container logging,
and the command below sends stdout directly to an operator-only temporary file.
Keep shell tracing off.

```sh
set +x
umask 077
invite_file=$(mktemp) && pilot_admin invite pilot-alice >"$invite_file"
```

On success, send the one-time `token`, its expiration (`expiresAt` in Unix
milliseconds), the employee ID and the pilot URL through your approved private
channel. Keep the code out of terminal transcripts, shared logs and test reports.
Delete the local capture after handoff. The recipient selects **Use an
invitation**, sets a password and signs in with the employee ID.

To revoke instead, run `pilot_admin revoke pilot-alice`. Revocation clears
that account's invitation, credentials and login sessions. Start the same
service after the offline command ends with `pilot_compose up -d --no-deps
employee-pilot`. Use `pilot_compose down --volumes` only when discarding a
disposable project.

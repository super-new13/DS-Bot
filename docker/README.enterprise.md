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

## Launch separate file policy and worker services

Run each role as its own process with Node.js 24. Use the launcher under
`bin/` in the installed DS Bot package. The worker also needs the public DSH
packages at the pinned version, available through normal Node module resolution.
Use a dedicated worker profile and private storage directories.

```sh
node /absolute/path/to/ds-bot/bin/ds-bot-enterprise-node.mjs policy --config /absolute/path/to/policy.mjs
node /absolute/path/to/ds-bot/bin/ds-bot-enterprise-node.mjs worker --config /absolute/path/to/worker.mjs
```

Each configuration file is **trusted executable JavaScript** and runs with the
service account's permissions. Restrict write access to the module and its
imports to the deployment operator. Export the role's options as the default
export. Use absolute paths for storage and TLS files. Keep credential material
in private files and keep it out of configuration source and logs.

- The policy options match `startFilePolicyRuntime`. Supply reservation and
  evidence store paths, listener TLS options, and the trusted `canReserve` and
  `authorizeScope` callbacks. With an evidence listener configured, enroll
  disjoint `workerGrants` and `evidenceListener.producerGrants`. The launcher
  creates the runtime's local evidence producer capability. An optional
  `onReady` callback receives the listener origins and local `revoke` function.
- The worker options match `createWorkerBootstrap`. Supply `config` and an
  injected model `adapter`. File tools require explicit trusted `fileTools`
  options. When using the outbox, supply `ingestEvidence` using the settlement
  delivery callback and distinct worker and producer credentials. An optional
  `onReady` callback receives the worker origin and, with an outbox configured,
  the bounded `drainEvidence` function. Keep any operator access to these local
  callbacks separate from employee traffic.

Both commands print one JSON readiness record with the role and listener
origins. They close their runtimes on SIGTERM or SIGINT. Startup failures use
fixed diagnostics. Operator modules are responsible for keeping their own
output private. Set `initialize: true` only to provision fresh stores and
assign one writer per store. These commands are invoked independently of the
employee Compose pilot.

### Run the node launchers through Compose

The file-policy and worker profiles start separate containers from a Node 24
image that installs the packed DS Bot package and pinned DSH 0.2.2-rc.1. Each
role starts as UID 1000 and has its own project-scoped volume at /home/node.
Provision state paths under that directory and use a separate private
subdirectory for the worker's business files if file tools are enabled. The
image skips npm lifecycle scripts. Check any additional native dependencies of
an operator-provided model adapter before selecting it for this image.

Set DSBOT_FILE_POLICY_CONFIG_DIR and DSBOT_WORKER_CONFIG_DIR to two separate
operator-controlled directories outside the build context. Include policy.mjs
and worker.mjs in their respective directories. Each mounts read-only at
/app/config. Include only the TLS files each role uses, readable by UID 1000.
Provision distinct server certificates and private keys for the listeners and
distinct client identities for ordinary worker requests and evidence delivery.
Keep producer and ordinary worker enrollments disjoint. Never mount policy
private keys or the policy state volume into the worker. The operator modules
supply the absolute TLS and state paths plus the callbacks described above.

The roles share the internal file-operations network. For communication within
a Compose project, configure listeners to bind at 0.0.0.0 and set the canonical
HTTPS origins to the relevant service DNS names and dedicated ports. Issue
certificates with matching DNS names, including the separate evidence listener
origin if configured. Use an injected mock model for isolated startup checks.
Model egress, employee-pilot connectivity and remote workers require an
operator-provisioned private route and matching TLS configuration. Keep the
route limited to the intended service peers. The base profiles publish zero
host ports and keep DSH on its own internal network.

Render the configuration from the repository root before any startup:

    docker compose --env-file /dev/null -f compose.enterprise.yml --profile file-policy --profile worker config --quiet
    node --test docker/test-enterprise.mjs

To start both roles in a disposable project with a local engine and provisioned
fixture directories, explicitly select the two services:

    docker compose --env-file /dev/null -f compose.enterprise.yml -p dsbot-node-smoke up --build file-policy worker

### Standalone owner console

Set the optional JSON settings below to enable the owner console. Create the
transcript directory inside the persistent employee volume before startup.
Use mode 0700 and make UID 1000 the owner. Keep the directory private. It
holds private chat turns and the audit records for owner transcript reads.

    "owner": {
      "tokenHash": "<64 lowercase hexadecimal characters>",
      "transcriptDirectory": "/home/node/private-transcripts"
    }

Generate the owner token from 32 cryptographically random bytes, encoded as
unpadded base64url. Put the SHA-256 digest of that encoded string in
`owner.tokenHash`. Keep the original token in a secure credential manager.
Open `/owner` on the employee HTTPS origin and enter the token there. The
page keeps the token in memory and clears it when the page is left or the
clear button is used. The owner API requires the canonical HTTPS Origin and
`Authorization: Bearer` credential. Choose **View audit records** to read the worker's redacted file authorization
and effect records. Enter the node ID when several workers are configured.
The worker must provision an audit file and grant the employee service's mTLS
peer fingerprint the `audit` action. A peer grant can omit `personId` and `botId`
only when all its actions are `audit`. The selected worker records each read.

### Owner console smoke

Run the owner and employee flow with:

    bash docker/smoke-enterprise-policy.sh --employee

Use --employee --config-only to verify the generated fixture and rule mounts
locally without Docker. The full run also validates the merged Compose model.
Its HTTPS probe runs inside the employee container and uses the public HTTPS
origin for the Host and Origin headers. The fixture asserts owner admission,
invite and revoke, transcript reads, worker audit records, rule changes,
and a create-only grant with an actual creation and denied modification.

The employee configuration uses owner.tokenHash for the lowercase SHA-256
hex digest of the owner bearer token. The owner.transcriptDirectory must be a
private pre-existing directory. The employee service writes owner.ruleFile
and owner.initializeRules provisions it on first startup. Mount the rule file's
parent directory into the policy and worker services read-only so they see
atomic replacements. Give the policy a trusted resolveTarget callback for the
worker's configured target.

To compute the digest from a private file holding just the token and an optional
trailing newline, pass its path to this command:

    python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read().rstrip(bytes([13,10]))).hexdigest())' < /private/owner-token

The smoke generates a disposable token per run, stores only its digest in the
employee configuration, and supplies the token to the probe over stdin.

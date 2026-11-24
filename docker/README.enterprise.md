# Enterprise Compose foundation

This opt-in fixture starts the existing DSH image with DS Bot installed. The
admin listener binds to container loopback, and Compose publishes zero ports.
The fixture requires no Relay configuration and has no employee routes.

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
scope. Its listener, transport, and service authentication are pending
validation against the public DSH plugin API. Network membership alone grants
no authority. Do not forward DSH admin URLs, generic plugin channels, or
employee-supplied identity headers. Supply deployment credentials out of band
once the authentication mechanism exists.

The existing image uses the full-access container preset. Keep employee access
disabled until a runtime configuration enforces the approved tool and data
boundaries. Future acceptance includes mock-model login, chat, SSE and
revocation, validation of admin isolation, and backup and restore of accounts,
authorizations, conversations, audits and business files.

# Employee private chat HTTPS transport probe

The probe mounts the existing employee private-chat Fetch handler on a Node
HTTPS listener bound to an ephemeral loopback port. It uses the employee
accounts module with in-memory state, a mock DSH worker, and a temporary
OpenSSL certificate that the test client trusts for loopback only.

Run from the repository root with Node 24 and an OpenSSL CLI that supports
-addext.

    node --test ds-bot/test/enterprise-ingress.test.js

Both tests passed on Node v24.13.0 and OpenSSL 3.0.19. They verify invite
redemption and login over HTTPS, forwarding of Secure, HttpOnly and SameSite
cookie attributes, and the scoped chat response. The client reads a queued
frame and a delta before releasing the mock worker to produce the final reply
and completion frame. Teardown closes the listener, destroys any remaining
sockets and removes the temporary certificate directory.

The bridge uses the configured public HTTPS origin to construct the Fetch URL.
It passes the original Origin header for the handler's same-origin check and
uses the TLS peer address for the auth client key. It drops caller-supplied
forwarding and identity headers. The signed-in account determines employee
identity even when those headers name another employee. A request without a
login cookie receives 401. A cross-origin request or an unassigned Bot receives
403. The listener returns 404 for an unexpected Host or a DSH API route.

The bridge forwards the parsed decimal Content-Length header as a string. An
accepted UTF-8 request carries its length in bytes and an over-limit numeric
value produces 413. An empty logout POST preserves Content-Length zero and
arrives without a Fetch body. The old login cookie then receives 401.

## Deployment gaps

The proof covers HTTP/1.1 with a mock worker. Production verification still
needs the deployed ingress and private adapter, browser cookie handling, SSE
through the deployed proxy, trusted proxy client-address mapping, and request
and disconnect timeouts. Worker cancellation on disconnect and durable replay
also remain unverified. Compose configuration renders without the daemon. The
enterprise Compose foundation exposes no listener, and the local default
Docker socket is absent, so container startup was not exercised.

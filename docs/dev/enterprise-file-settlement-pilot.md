# File settlement pilot

The loopback mTLS fixture reserves one exact write, requests revocation, and then commits the authorized bytes with the existing local file dispatcher. Revocation refuses fresh reservations and stays pending through a timed-out settlement request, a closed listener, and reopening the central stores. Once an independent fixture producer records the observed effect, the worker can settle the exact reservation. A foreign target is refused, and repeating the original reservation returns its completed status without issuing another permit.

The fixture converts the confirmed reservation into a local authorization predicate tied to the actor, request, dispatch, fixed target, original file version, and content digest. Production would need a verified bridge at the effect boundary where the dispatcher currently consumes a local authorization. See [file-dispatch.js](../../ds-bot/src/host/enterprise/file-dispatch.js#L38).

The fixture producer observes the successful local effect callback and checks the resulting bytes and file version before ingesting evidence. Production still needs an independent producer that can attribute a durable effect to the exact reservation after crashes or disconnection. A matching file digest by itself supplies no dispatch attribution. The runtime exposes restricted ingestion, and the settlement endpoint only verifies evidence already recorded. See [file-policy-runtime.js](../../ds-bot/src/host/enterprise/file-policy-runtime.js#L41) and [file-reservation-http.js](../../ds-bot/src/host/enterprise/file-reservation-http.js#L80).

Run from the repository root with Node.js 24 and OpenSSL on POSIX.

    node --test ds-bot/test/enterprise-file-settlement-pilot.test.js

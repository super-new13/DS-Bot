# Scoped DSH file tool proof

The fixture uses DSH 0.2.2-rc.1, a mock model and adjudicator, and a temporary worker-owned directory. The fixture records a trusted actor and request ID alongside the exact DSH user message before submitting it. The live Session event listener recognizes admission by matching the message ID within an open turn and clears the binding on turn end.

The public tools/execute wrapper checks the Agent, tool name, root call ID and cancellation signal. The tool body verifies the same opaque execution token and call ID before invoking createWorkerFileDispatch. The guarded dispatcher rechecks live authorization against the admitted turn and dispatch at approval and consumption. Only the note content comes from tool arguments. The fixture supplies the target path and expected file version.

One authorized call commits one write and records a successful tool result. A foreign actor, revocation while the mock adjudicator is pending, and a mismatched dispatch ID all leave the original bytes intact and record failed tool results.

The fixture owns admission and tool registration. Its production counterpart needs a trusted accessor for the admitted run in worker-session.js, plus an explicit isolated registration policy in worker-runtime.js, which currently denies tools. Generic approvals, nested calls, and production registration remain unverified. The existing guard also requires a worker-owned directory.

Run from the repository root with the pinned Harness packages installed:

    DSH_HARNESS="$PWD/ds-bot/dev/harness" node --import ./ds-bot/test/harness-resolve.mjs --test ds-bot/test/enterprise-worker-file-tool.test.js

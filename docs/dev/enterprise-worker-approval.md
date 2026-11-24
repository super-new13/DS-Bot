# Worker approval and dispatch identity

DSH 0.2.2-rc.1 supports a dispatch-bound approval for a worker-owned native structured tool. The fixture runs the real AgentLoop, tool registry and ApprovalService with a mock model and an in-memory record tool.

The worker-owned `tools/execute` wrapper captures the live Agent, dispatch call ID, opaque execution token, and frozen structured arguments. The wrapper calls `ctx.approval.request` inside that dispatch's async context. The terminal `approval/request` listener checks the Agent, tool, call ID and signal against the pending dispatch and evaluates those captured arguments. The wrapper checks the decision, rule version and dispatch again before delegating once. The tool body sees the same execution token and records exactly one in-memory change. Session events record the approval ask and decision before the tool result.

The matching dispatch succeeds. Missing IDs, mismatched IDs, an ask outside dispatch context and different argument values all deny the call before the tool body. A simulated rule-version change after the decision also prevents execution even though the approval audit records `allowed-once`.

## Integration limits

The published ApprovalService documentation and `ApprovalRequestEvent` declaration expose an optional call ID and no structured arguments. The fixture supplies its own context binding and ask-before-body order using the public hooks. A pre-existing ask, a shared root call ID or a tool name alone provides insufficient evidence to grant dispatch. The approval audit ID pairs the ask and outcome. It does not establish employee identity or identify an execution token.

The evidence covers one native root dispatch in a composed fixture with one terminal answerer. Existing tool-specific or preset approvals, approvals outside the wrapper, PTC/nested dispatches, and concurrent or cross-session correlation remain unverified. Keep automatic authorization closed on those paths. Production integration still needs authoritative employee and request attribution, revocation and version rechecks at the actual effect boundary, atomic file-version handling and audit receipt recovery. The fixture makes no filesystem changes as a tool effect and starts no endpoint.

## Reproduce

From the repository root after installing the pinned packages with `npm --prefix ds-bot run harness`:

```sh
DSH_HARNESS="$PWD/ds-bot/dev/harness" node --import ./ds-bot/test/harness-resolve.mjs --test ./ds-bot/test/enterprise-worker-approval.test.js
```

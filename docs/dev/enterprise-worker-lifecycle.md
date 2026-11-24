# Remote DSH worker lifecycle proof

The fixture uses published DSH 0.2.2-rc.1 packages with the documented AgentLoop testkit and an in-process mock model. It creates two native Sessions with the Agent registry's public create method. It does not mount the Session Controller, compose workspace or preset configuration, or launch a listener.

From the repository root, after installing the pinned packages with `npm --prefix ds-bot run harness`:

```sh
DSH_HARNESS="$PWD/ds-bot/dev/harness" node --import ./ds-bot/test/harness-resolve.mjs --test ./ds-bot/test/enterprise-worker-lifecycle.test.js
```

- `ctx.agents.create` publishes a fresh Agent and Session, and `ctx.agents.get` resolves the live Agent by Session ID. Two independent Sessions reach the mock model while both responses are still held.
- `agent/assistant-stream` emits live frames keyed by Agent Session and attempt. The fixture sees partial text before either turn ends and matches the surviving attempt's end frame to the `assistant/message` sequence from `session/event`. Live chunk indexes are local to an attempt. The worker still needs a durable replay cursor and a filtered business event projection.
- `Agent.cancel` is scoped to the current activity of one Agent. The fixture sees the target model signal abort, the target pending next-turn message disappear under default cancellation, and the other Session finish successfully. The documented `keepInbox` option preserves pending work. It does not select which active request is stopped. A shared Session needs an authoritative active-request match at the stop boundary and must refuse ambiguous ownership. The fixture exercises an abort-aware model stream. It does not verify cancellation of a running tool, pending approval, subagent, or an already committed effect.

## Approval and execution identity

The published `dsh-user-approval/lib/types/types.d.ts` defines `approval/request` with Agent, tool name, optional `callId`, and contextual reason and signal, without structured tool arguments. The approval audit ID pairs the ask and decision. In `dsh-tools/lib/types/contracts.d.ts`, `tools/execute` exposes the actual structured arguments plus dispatch call identity and `rootCallId`. A root call can have several nested dispatches. An approval ID, root ID, tool name, or Session ID alone cannot identify a particular employee request and exact dispatch. This proof does not establish hook order, call ID equality across all approval paths, or atomic binding of caller, arguments, rule version and commit. Keep automatic authorization closed for calls without verified attribution and exact execution identity.

Workspace/preset composition, authorization and revocation, shared-room request binding, restart/reconnect receipts, and two-node behavior still need integration evidence. Keep worker endpoints closed until shared contract review.

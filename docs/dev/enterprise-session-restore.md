# Scoped native Session restoration

The DSH 0.2.2-rc.1 probe uses two separate Node processes and one disposable
storage root. The first creates two native Sessions for different employees
on the same Bot and node, records each binding with openWorkerSessionMapping,
completes a mock turn in each, and shuts down. The second reopens the mapping
and resumes the first employee's Session. Its next model call receives that
employee's saved prompt and assistant reply before the new prompt. Attempts to
resume with a foreign employee, Bot, or node fail before the Agent is loaded.

## Public API

Mount the dedicated worker's AgentLoop services and add the public plugin
namespace from @deepseek-ai/dsh-session-persistence-jsonl with
ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' }). Create
Sessions with ctx.agents.create({ sessionId, agentOptions, meta: { cwd } }).
After a completed turn, await ctx.sessions.flush(agent.session) for the
persistence checkpoint. Dispose the owned Agent handles before tearing down
the root Context to drain the write handles.

At restoration, verify the full server-resolved employee, Bot, and node
binding and match the requested native Session ID before calling
ctx.agents.resume({ resumeSessionId, agentOptions }). Resume preserves the
Session ID. A fresh scoped setup is available through the resume setup option,
including a synchronous publication callback for checking mutable grants.
The fixture uses the restored model history to verify continuity.

## Verification

From the repository root with the pinned Harness dependencies installed:

    DSH_HARNESS="$PWD/ds-bot/dev/harness" node --import ./ds-bot/test/harness-resolve.mjs --test ds-bot/test/enterprise-session-restore.test.js

The production worker plugin currently mounts the in-memory Session service
and keeps Agent ownership in memory. Integration needs the durable backend,
owned resume handles, live authorization at publication and dispatch, and
receipt reconciliation before working on a restored Session. This probe
covers a clean restart after completed turns. Interrupted turns, session
rollover, production restore routing, and client event replay still need
verification.

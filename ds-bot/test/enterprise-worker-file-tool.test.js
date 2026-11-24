import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createWorkerFileDispatch } from '../src/host/enterprise/file-dispatch.js'
import { createWorkerFileEffects } from '../src/host/enterprise/file-effects.js'

const name = 'fixture_write'
const callId = 'fixture-call'
const sessionId = SessionId('fixture-session')

for (const mode of ['approved', 'foreign actor', 'revoked while awaiting', 'mismatched dispatch']) {
  test('guarded DSH file tool: ' + mode, { skip: process.platform === 'win32', timeout: 6000 }, async t => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'worker-tool-'))
    const path = join(root, 'note')
    writeFileSync(path, 'initial')
    const ctx = new Context()
    const answer = Promise.withResolvers()
    t.after(async () => {
      answer.resolve()
      try { await ctx.fiber.dispose() } finally { rmSync(root, { force: true, recursive: true }) }
    })
    await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
    const scope = { sessionId, botId: 'helper', roomId: 'general', requestId: 'fixture-request',
      personId: mode === 'foreign actor' ? 'bob' : 'alice',
    }
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Update the fixture note' }] })
    const { inspectVersion } = createWorkerFileEffects({ root, workerOwned: true, authorization: { consume: () => false } })
    const version = inspectVersion(path)
    const binding = new AsyncLocalStorage()
    const judging = Promise.withResolvers()
    let judgments = 0
    let writes = 0
    let revoked = false
    let turn
    let admitted = false
    let agent
    ctx.on('session/event', (session, event) => {
      if (session !== agent?.session) return
      if (event.type === 'turn/start') { turn = event.data.turn; admitted = false }
      if (event.type === 'user/message') admitted = turn !== undefined && event.data.id === message.id
      if (event.type === 'turn/end') { turn = undefined; admitted = false }
    })
    const dispatch = createWorkerFileDispatch({ root, workerOwned: true,
      readRules: () => ({ version: 'v1', rules: [{ id: 'note', personId: 'alice', botId: 'helper', roomId: 'general',
        directory: root, grant: 'write', effect: 'allow', purpose: 'Update the fixture note',
      }] }),
      isAuthorized(action) {
        const live = binding.getStore()
        return Boolean(live && live.open && admitted && live.turn === turn && !revoked && !live.signal.aborted
          && action.dispatchId === live.callId && Object.keys(scope).every(key => action[key] === scope[key]))
      },
      async adjudicate({ rule }) {
        judgments++
        if (mode === 'revoked while awaiting') {
          judging.resolve()
          await answer.promise
        }
        return { verdict: 'allow', ruleId: rule.id, ruleVersion: rule.version, reason: 'Matches fixture purpose' }
      },
    })
    ctx.on('tools/execute', async (exec, next) => {
      if (!admitted || exec.agent !== agent || exec.name !== name || exec.parent !== undefined
          || exec.rootCallId !== exec.callId || exec.signal.aborted) throw new Error('Unbound fixture dispatch')
      const live = { open: true, turn, callId: exec.callId, token: exec.token, signal: exec.signal }
      try { return await binding.run(live, next) } finally { live.open = false }
    })
    ctx.tools.register({
      name, description: 'Update the single fixture note',
      parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false },
      output: { schema: { type: 'string' }, render: text => [{ type: 'text', text }] },
      async execute(args, exec) {
        const live = binding.getStore()
        if (exec.token !== live?.token || exec.callId !== live.callId) throw new Error('Dispatch identity changed')
        await dispatch({ ...scope, dispatchId: mode === 'mismatched dispatch' ? 'other-call' : exec.callId }, {
          operation: 'modify', path, version, content: Buffer.from(args.content),
        })
        writes++
        return 'written'
      },
    })
    let steps = 0
    class MockModel extends LlmAdapter {
      providerInfo() { return { id: 'mock', name: 'Mock' } }
      async resolveModel(provider, id) {
        return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } }
      }
      async *stream() {
        if (steps++ === 0) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call', id: callId, name }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: JSON.stringify({ content: 'approved' }) } }
          yield { type: 'finish', reason: { kind: 'tool-use' } }
        } else yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new MockModel())
    const harness = await mountAgentLoopTestHarness(ctx)
    agent = await harness.create(sessionId, { provider: 'mock', model: 'mock' })
    agent.followup(message)
    if (mode === 'revoked while awaiting') {
      await judging.promise
      assert.equal(readFileSync(path, 'utf8'), 'initial')
      revoked = true
      answer.resolve()
    }
    await agent.whenIdle()
    const allowed = mode === 'approved'
    assert.equal(readFileSync(path, 'utf8'), allowed ? 'approved' : 'initial')
    assert.equal(writes, allowed ? 1 : 0)
    assert.equal(judgments, allowed || mode === 'revoked while awaiting' ? 1 : 0)
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    assert.equal(results.length, 1)
    assert.equal(results[0].data.message.toolCallId, callId)
    assert.equal(results[0].data.message.isError === true, !allowed)
  })
}

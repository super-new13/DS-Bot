import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { openWorkerSessionMapping } from '../src/host/enterprise/session-mapping.js'

const alice = { nodeId: 'node-a', personId: 'alice', botId: 'helper', sessionId: 'alice-session' }
const bob = { ...alice, personId: 'bob', sessionId: 'bob-session' }
const agentOptions = { provider: 'mock', model: 'model' }

class MockModel extends LlmAdapter {
  calls = []
  providerInfo() { return { id: 'mock', name: 'Mock' } }
  async resolveModel(provider, id) {
    return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 }, defaultMaxTokens: 1000 }
  }
  async *stream({ messages }) {
    this.calls.push(messages.filter(message => message.role !== 'system')
      .flatMap(message => (message.content ?? []).flatMap(block => block.type === 'text' ? [block.text] : [])))
    const text = 'mock answer'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function run(phase, dir) {
  const ctx = new Context()
  const adapter = new MockModel()
  const mapping = await openWorkerSessionMapping(join(dir, 'ownership.json'), { initialize: phase === 'create' })
  const handles = []
  async function send(agent, text) {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
  }
  async function resume(scope) {
    const saved = await mapping.lookup(scope)
    if (saved?.sessionId !== scope.sessionId) throw Object.assign(new Error('Session refused'), { code: 'not-authorized' })
    return ctx.agents.resume({ resumeSessionId: saved.sessionId, agentOptions })
  }
  try {
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(dir, 'sessions'), compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    if (phase === 'create') {
      for (const [scope, prompt] of [[alice, 'alice saved prompt'], [bob, 'bob saved prompt']]) {
        const handle = await ctx.agents.create({ sessionId: scope.sessionId, agentOptions, meta: { cwd: dir } })
        handles.push(handle)
        await mapping.bind(scope)
        await send(handle.agent, prompt)
      }
      assert.equal(adapter.calls.length, 2)
    } else {
      for (const foreign of [{ ...alice, personId: 'bob' }, { ...alice, botId: 'other' }, { ...alice, nodeId: 'other' }]) {
        await assert.rejects(resume(foreign), { code: 'not-authorized' })
        assert.equal(ctx.agents.get(alice.sessionId), undefined)
      }
      const handle = await resume(alice)
      handles.push(handle)
      assert.equal(handle.agent.session.id, alice.sessionId)
      assert.equal(ctx.agents.get(bob.sessionId), undefined)
      assert.equal(adapter.calls.length, 0)
      await send(handle.agent, 'alice new prompt')
      assert.deepEqual(adapter.calls, [['alice saved prompt', 'mock answer', 'alice new prompt']])
    }
  } finally {
    try {
      for (const handle of handles) await handle.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  }
}

const phase = process.argv[2]
if (phase === 'create' || phase === 'resume') {
  await run(phase, process.cwd())
} else {
  test('restores only the owned native session and its history after process restart', { timeout: 25000 }, t => {
    const dir = mkdtempSync(join(tmpdir(), 'dsbot-session-restore-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const resolver = fileURLToPath(new URL('./harness-resolve.mjs', import.meta.url))
    for (const action of ['create', 'resume']) {
      execFileSync(process.execPath, ['--import', resolver, fileURLToPath(import.meta.url), action], {
        cwd: dir, timeout: 10000,
        env: { DSH_HOME: dir, DSH_HARNESS: process.env.DSH_HARNESS,
          ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }) },
      })
    }
  })
}

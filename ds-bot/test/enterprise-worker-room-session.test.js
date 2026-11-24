import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { openWorkerSessionMapping } from '../src/host/enterprise/session-mapping.js'

import { createWorkerSessionAdapter } from '../src/host/enterprise/worker-session.js'

const alice = { nodeId: 'node-a', botId: 'helper' }
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

async function boot(dir, initialize, deniedActors) {
  const ctx = new Context()
  const model = new MockModel()
  const mapping = await openWorkerSessionMapping(join(dir, 'ownership.json'), { initialize })
  const sessionRoot = join(dir, 'sessions')
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], model)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const checks = []
  const worker = createWorkerSessionAdapter(ctx, { ...agentOptions, nodeId: alice.nodeId, mapping, sessionRoot,
    authorize(scope, requestId) {
      checks.push({ ...scope, requestId })
      return ['alice', 'bob'].includes(scope.personId) && !deniedActors.has(scope.personId)
    },
  })
  return { ctx, worker, model, checks, async close() {
    try { await worker.close() } finally { await ctx.fiber.dispose() }
  } }
}

const room = (personId, roomId = 'general') => ({ personId, botId: alice.botId, roomId,
  sessionKey: JSON.stringify(['room', alice.nodeId, alice.botId, roomId]),
})
const privateScope = { personId: 'alice', botId: alice.botId, sessionKey: JSON.stringify([alice.nodeId, alice.botId, 'alice']) }
const refused = { code: 'not-authorized' }

test('room actors share only the room Session and resume its scoped history', { timeout: 8000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-worker-room-'))
  const deniedActors = new Set()
  const first = await boot(dir, true, deniedActors)
  let current = first
  t.after(async () => {
    try { await current?.close() } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  const [sharedA, sharedB] = await Promise.all([first.worker.create(room('alice')), first.worker.create(room('bob'))])
  assert.equal(sharedA.sessionId, sharedB.sessionId)
  assert.equal(sharedA.personId, 'alice')
  assert.equal(sharedB.personId, 'bob')
  assert.equal(sharedA.roomId, 'general')
  const personal = await first.worker.create(privateScope)
  const foreign = await first.worker.create(room('alice', 'other'))
  assert.equal(new Set([sharedA.sessionId, personal.sessionId, foreign.sessionId]).size, 3)
  const input = { ...sharedA, requestId: 'original', text: 'first room prompt' }
  for (const sessionId of [personal.sessionId, foreign.sessionId]) {
    await assert.rejects(first.worker.submit({ ...input, sessionId }), refused)
  }
  const events = []
  const cancelled = await first.worker.submit({ ...input, requestId: 'cancelled' }, event => {
    events.push(event)
    if (event.type === 'delta') {
      assert.throws(() => first.worker.cancel({ ...input, requestId: 'cancelled', personId: 'bob' }), refused)
      assert.deepEqual(first.worker.cancel({ ...input, requestId: 'cancelled' }), { accepted: true })
    }
  })
  assert.equal(cancelled.status, 'aborted')
  assert.equal(events[0].personId, 'alice')
  assert.equal(events[0].roomId, 'general')
  assert.equal((await first.worker.submit(input)).status, 'completed')
  assert.ok(first.checks.some(check => check.requestId === 'original' && check.personId === 'alice' && check.roomId === 'general'))
  await first.close()
  current = undefined
  const second = await boot(dir, false, deniedActors)
  current = second
  const next = { ...sharedB, requestId: 'next', text: 'second room prompt' }
  await assert.rejects(second.worker.submit({ ...next, sessionId: personal.sessionId }), refused)
  assert.equal(second.ctx.agents.get(personal.sessionId), undefined)
  deniedActors.add('bob')
  await assert.rejects(second.worker.submit(next), refused)
  assert.equal(second.ctx.agents.get(sharedB.sessionId), undefined)
  deniedActors.delete('bob')
  const afterRestart = []
  assert.equal((await second.worker.submit(next, event => afterRestart.push(event))).status, 'completed')
  assert.ok(afterRestart.every(event => event.personId === 'bob' && event.roomId === 'general' && event.sessionId === sharedA.sessionId))
  assert.ok(second.model.calls[0].includes('first room prompt'))
  assert.equal(second.model.calls[0].at(-1), 'second room prompt')
  assert.equal((await second.worker.create(room('alice'))).sessionId, sharedA.sessionId)
  const revokedEvents = []
  await assert.rejects(second.worker.submit({ ...next, requestId: 'revoked' }, event => {
    revokedEvents.push(event.type)
    deniedActors.add('bob')
  }), refused)
  assert.deepEqual(revokedEvents, ['delta'])
})

import assert from 'node:assert/strict'
import { addAbortListener } from 'node:events'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

function holdStream(gate, signal) {
  const aborted = Promise.withResolvers()
  const listener = addAbortListener(signal, () => aborted.reject(signal.reason))
  return Promise.race([gate, aborted.promise]).finally(() => listener[Symbol.dispose]())
}

test('two worker Sessions stream independently and cancelling one leaves the other running', { timeout: 8000 }, async t => {
  const ctx = new Context()
  const ids = ['worker-alpha', 'worker-beta'].map(SessionId)
  const streams = new Map(ids.map(id => [id, {
    first: Promise.withResolvers(), release: Promise.withResolvers(), frames: [], events: [], requests: [],
  }]))
  t.after(async () => {
    for (const stream of streams.values()) stream.release.resolve()
    await ctx.fiber.dispose()
  })
  await mountAgentLoopTestDependencies(ctx)

  class MockAdapter extends LlmAdapter {
    providerInfo() { return { id: 'mock', name: 'Mock' } }
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 }, defaultMaxTokens: 1000 }
    }
    async *stream({ sessionId, signal }) {
      const stream = streams.get(sessionId)
      stream.requests.push(signal)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: sessionId }
      await holdStream(stream.release.promise, signal)
      yield { type: 'text-delta', index: 0, text: ' done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: sessionId + ' done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  ctx.llm.registerAdapter(['mock'], new MockAdapter())
  await mountAgentLoopTestHarness(ctx)
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const stream = streams.get(agent.session.id)
    if (stream === undefined) return
    stream.frames.push(frame)
    if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') stream.first.resolve(frame.chunk.text)
  })
  ctx.on('session/event', (session, event) => streams.get(session.id)?.events.push(event))

  const create = async sessionId => (await ctx.agents.create({ sessionId, agentOptions: { provider: 'mock', model: 'mock' } })).agent
  const alpha = await create(ids[0])
  const beta = await create(ids[1])
  assert.equal(ctx.agents.get(ids[0]), alpha)
  assert.equal(ctx.agents.get(ids[1]), beta)
  assert.notEqual(alpha.session, beta.session)
  const a = streams.get(ids[0])
  const b = streams.get(ids[1])

  alpha.followup(message('first'))
  assert.equal(await a.first.promise, ids[0])
  beta.followup(message('second'))
  assert.equal(await b.first.promise, ids[1])
  assert.ok([a, b].every(stream => !stream.events.some(event => event.type === 'turn/end')))

  const pending = message('queued on alpha')
  alpha.send(pending, 'next-turn')
  assert.ok(alpha.inbox.nextTurn.some(item => item.id === pending.id))
  alpha.cancel({ kind: 'hook', reason: 'worker-fixture-stop' })
  await alpha.whenIdle()
  assert.equal(a.requests[0].aborted, true)
  assert.deepEqual(alpha.inbox.nextTurn, [])
  assert.equal(a.requests.length, 1)
  assert.equal(a.events.find(event => event.type === 'turn/end')?.data.reason.kind, 'aborted')
  assert.equal(b.requests[0].aborted, false)
  assert.equal(b.events.some(event => event.type === 'turn/end'), false)

  b.release.resolve()
  await beta.whenIdle()
  const completed = b.events.find(event => event.type === 'assistant/message')
  const end = b.frames.at(-1)
  assert.equal(end.type, 'end')
  assert.deepEqual(end.outcome, { kind: 'committed', eventType: 'assistant/message', seq: completed.seq })
  const chunks = b.frames.filter(frame => frame.type === 'chunk')
  assert.deepEqual(chunks.map(frame => frame.index), chunks.map((_, index) => index))
  assert.ok(b.frames.every(frame => frame.attemptId === end.attemptId))
  assert.deepEqual(chunks.flatMap(({ chunk }) => chunk.type === 'text-delta' ? [chunk.text] : []), [ids[1], ' done'])
  assert.equal(b.events.find(event => event.type === 'turn/end')?.data.reason.kind, 'completed')
})

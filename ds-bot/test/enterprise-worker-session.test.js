import assert from 'node:assert/strict'
import { addAbortListener } from 'node:events'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createWorkerSessionAdapter } from '../src/host/enterprise/worker-session.js'

const refused = { code: 'not-authorized' }

async function fixture(t) {
  const ctx = new Context()
  const streams = new Map()
  const revoked = new Set()
  t.after(async () => {
    for (const gate of streams.values()) gate.release.resolve()
    await ctx.fiber.dispose()
  })
  await mountAgentLoopTestDependencies(ctx)
  class MockAdapter extends LlmAdapter {
    providerInfo() { return { id: 'mock', name: 'Mock' } }
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 }, defaultMaxTokens: 1000 }
    }
    async *stream({ signal, sessionId }) {
      const gate = streams.get(sessionId)
      if (gate) gate.signal = signal
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: gate?.label ?? 'outside worker' }
      if (gate) {
        const abort = Promise.withResolvers()
        const listener = addAbortListener(signal, () => abort.reject(signal.reason))
        try { await Promise.race([gate.release.promise, abort.promise]) } finally { listener[Symbol.dispose]() }
      }
      yield { type: 'text-delta', index: 0, text: ' done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: (gate?.label ?? 'outside worker') + ' done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new MockAdapter())
  const harness = await mountAgentLoopTestHarness(ctx)
  const options = { provider: 'mock', model: 'mock' }
  const worker = createWorkerSessionAdapter(ctx, {
    ...options,
    authorize: ({ personId, botId }, requestId) => ['alpha', 'beta'].includes(personId) && botId === 'bot'
      && !revoked.has(personId) && !revoked.has(requestId),
  })
  const create = personId => worker.create({ sessionKey: personId + ':bot', personId, botId: 'bot' })
  function run(scope, requestId) {
    const release = Promise.withResolvers()
    const first = Promise.withResolvers()
    const gate = { label: requestId, release }
    const input = { ...scope, requestId, text: 'hello' }
    streams.set(scope.sessionId, gate)
    const events = []
    const done = worker.submit(input, event => {
      events.push(event)
      if (event.type === 'delta') first.resolve(event.text)
    })
    void done.then(() => first.resolve(undefined), first.reject)
    return { input, first: first.promise, release: release.resolve, done, events, gate }
  }
  return { ctx, worker, create, run, revoked, createOutside: () => harness.create(SessionId('outside-worker'), options) }
}

test('worker streams two Sessions independently and stops only the matched request', { timeout: 8000 }, async t => {
  const { worker, create, run, createOutside } = await fixture(t)
  const [alpha, beta] = await Promise.all([create('alpha'), create('beta')])
  assert.notEqual(alpha.sessionId, beta.sessionId)
  const a = run(alpha, 'request-a')
  const b = run(beta, 'request-b')
  assert.deepEqual(await Promise.all([a.first, b.first]), ['request-a', 'request-b'])

  const outside = await createOutside()
  outside.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }))
  await outside.whenIdle()

  assert.throws(() => worker.cancel({ ...a.input, requestId: b.input.requestId }), refused)
  assert.throws(() => worker.cancel({ ...a.input, personId: 'beta' }), refused)
  assert.throws(() => worker.cancel({ ...a.input, sessionId: beta.sessionId }), refused)
  assert.equal(a.gate.signal.aborted, false)
  assert.equal(b.gate.signal.aborted, false)
  assert.deepEqual(worker.cancel(a.input), { accepted: true })
  assert.equal((await a.done).status, 'aborted')
  assert.equal(a.gate.signal.aborted, true)
  assert.equal(b.gate.signal.aborted, false)
  b.release()
  assert.equal((await b.done).status, 'completed')
  assert.deepEqual(a.events.map(event => event.type), ['delta', 'done'])
  assert.deepEqual(b.events.map(event => event.type), ['delta', 'delta', 'reply', 'done'])
  assert.equal(b.events[2].text, 'request-b done')
  assert.ok(Number.isSafeInteger(b.events[2].seq))
  for (const { input, events } of [a, b]) {
    assert.ok(events.every(e => e.sessionId === input.sessionId && e.requestId === input.requestId))
  }
  assert.throws(() => worker.cancel(a.input), refused)
  const later = run(alpha, 'request-later')
  assert.equal(await later.first, 'request-later')
  assert.throws(() => worker.cancel(a.input), refused)
  await assert.rejects(worker.submit({ ...later.input, requestId: 'overlap' }), refused)
  later.release()
  assert.equal((await later.done).status, 'completed')
  await assert.rejects(worker.submit(later.input), refused)
})

test('worker denies unknown ownership and stops delivering events after revocation', { timeout: 8000 }, async t => {
  const { worker, create, run, revoked } = await fixture(t)
  await assert.rejects(create('unknown'), refused)
  const alpha = await create('alpha')
  await assert.rejects(create('alpha'), refused)
  const input = { ...alpha, requestId: 'forged', text: 'hello' }
  for (const forged of [{ sessionId: 'unknown' }, { botId: 'other' }, { personId: 'beta' }, { sessionKey: 'other' }]) {
    await assert.rejects(worker.submit({ ...input, ...forged }), refused)
  }
  const active = run(alpha, 'before-revocation')
  assert.equal(await active.first, 'before-revocation')
  revoked.add(active.input.requestId)
  assert.throws(() => worker.cancel(active.input), refused)
  revoked.delete(active.input.requestId)
  active.release()
  await assert.rejects(active.done, refused)
  assert.deepEqual(active.events.map(event => event.type), ['delta'])
})

test('worker cannot cancel before admission or with unrelated pending input', { timeout: 8000 }, async t => {
  const { ctx, worker, create, run } = await fixture(t)
  const alpha = await create('alpha')
  const active = run(alpha, 'before-admission')
  assert.throws(() => worker.cancel(active.input), refused)
  assert.equal(await active.first, 'before-admission')
  const agent = ctx.agents.get(alpha.sessionId)
  const other = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'unowned input' }] })
  agent.send(other, 'next-turn')
  assert.throws(() => worker.cancel(active.input), refused)
  assert.equal(active.gate.signal.aborted, false)
  active.release()
  await assert.rejects(active.done, refused)
  assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
  await assert.rejects(worker.submit({ ...active.input, requestId: 'new' }), refused)
})

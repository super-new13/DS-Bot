import assert from 'node:assert/strict'
import { addAbortListener } from 'node:events'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { createEmployeeAccounts } from '../src/host/enterprise/accounts.js'
import { canAccessEmployeeBot } from '../src/host/enterprise/authorization.js'
import { createEmployeePrivateChatHandler } from '../src/host/enterprise/private-chat-http.js'
import { createWorkerSessionAdapter } from '../src/host/enterprise/worker-session.js'

const origin = 'https://employee.example.test'
const password = 'mock employee password'

function post(path, data, cookie, headers = {}) {
  return new Request(origin + '/api/enterprise/' + path, {
    method: 'POST', body: JSON.stringify(data),
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
  })
}

async function fixture(t) {
  const ctx = new Context()
  const gates = new Map()
  const calls = []
  t.after(async () => {
    for (const gate of gates.values()) gate.resolve()
    await ctx.fiber.dispose()
  })
  let state = { accounts: {}, sessions: [] }
  const accounts = createEmployeeAccounts({
    read: () => structuredClone(state),
    transact(change) {
      const next = structuredClone(state)
      const result = change(next)
      state = next
      return result
    },
  })
  const roster = { people: {}, bots: { helper: { id: 'helper' }, private: { id: 'private', private: true } } }
  await mountAgentLoopTestDependencies(ctx)
  class MockAdapter extends LlmAdapter {
    providerInfo() { return { id: 'mock', name: 'Mock' } }
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 }, defaultMaxTokens: 1000 }
    }
    async *stream({ sessionId, messages, signal }) {
      const text = messages.findLast(message => message.role === 'user').content[0].text
      calls.push({ sessionId, text, signal })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      const gate = gates.get(text)
      if (gate) {
        const abort = Promise.withResolvers()
        const listener = addAbortListener(signal, () => abort.reject(signal.reason))
        try { await Promise.race([gate.promise, abort.promise]) } finally { listener[Symbol.dispose]() }
      }
      yield { type: 'text-delta', index: 0, text: ' done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: text + ' done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new MockAdapter())
  await mountAgentLoopTestHarness(ctx)
  const worker = createWorkerSessionAdapter(ctx, {
    provider: 'mock', model: 'mock', authorize: ({ personId, botId }) => canAccessEmployeeBot(roster, personId, botId),
  })
  const handle = createEmployeePrivateChatHandler({
    accounts, origin, readRoster: () => roster, resolveBot: botId => ({ botId, nodeId: 'mock-node', worker }),
    limits: { maxActive: 2, maxPerBot: 2, maxPerNode: 2, maxPending: 4 }, maxBodyBytes: 256,
  })
  const request = (path, data, cookie, headers) => handle(post('private-chat/' + path, data, cookie, headers))
  async function invite(personId) {
    roster.people[personId] = { id: personId, botIds: ['helper', 'private'] }
    const { token } = await accounts.issueInvite(personId)
    assert.equal((await handle(post('auth/redeem', { token, password }))).status, 204)
    const login = await handle(post('auth/login', { personId, password }))
    assert.equal(login.status, 204)
    return login.headers.get('Set-Cookie').split(';', 1)[0]
  }
  function hold(text) {
    const gate = Promise.withResolvers()
    gates.set(text, gate)
    return gate.resolve
  }
  async function send(cookie, text, headers) {
    const response = await request('send', { botId: 'helper', text }, cookie, headers)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('Content-Type'), /^text\/event-stream/)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    const reader = response.body.getReader()
    async function read() {
      const { value, done } = await reader.read()
      if (done) return undefined
      const text = new TextDecoder().decode(value)
      assert.ok(text.startsWith('data: ') && text.endsWith('\n\n'))
      return JSON.parse(text.slice(6))
    }
    const { type, requestId } = await read()
    assert.equal(type, 'queued')
    assert.equal(typeof requestId, 'string')
    return { requestId, read }
  }
  return { handle, request, invite, hold, send, calls, roster }
}

test('invited employees stream in separate sessions and only the owner can cancel the active request', { timeout: 8000 }, async t => {
  const { request, invite, hold, send, calls } = await fixture(t)
  const alice = await invite('alice')
  const bob = await invite('bob')
  hold('Alice text')
  const release = hold('Bob text')
  const aliceLength = Buffer.byteLength(JSON.stringify({ botId: 'helper', text: 'Alice text' }))
  const [a, b] = await Promise.all([send(alice, 'Alice text', { 'Content-Length': String(aliceLength) }), send(bob, 'Bob text')])
  assert.deepEqual(await a.read(), { type: 'delta', requestId: a.requestId, text: 'Alice text' })
  assert.deepEqual(await b.read(), { type: 'delta', requestId: b.requestId, text: 'Bob text' })
  assert.notEqual(calls[0].sessionId, calls[1].sessionId)
  const cancellation = { botId: 'helper', requestId: a.requestId }
  assert.equal((await request('cancel', cancellation, bob)).status, 403)
  assert.equal((await request('cancel', cancellation, alice, { Origin: 'https://sibling.example.test' })).status, 403)
  assert.equal((await request('cancel', { ...cancellation, requestId: 'unknown' }, alice)).status, 403)
  assert.ok(calls.every(call => !call.signal.aborted))
  for (const [length, status] of [['d', 400], ['257', 413]]) {
    assert.equal((await request('cancel', cancellation, alice, { 'Content-Length': length })).status, status)
  }
  const cancelLength = Buffer.byteLength(JSON.stringify(cancellation))
  assert.equal((await request('cancel', cancellation, alice, { 'Content-Length': String(cancelLength) })).status, 202)
  assert.deepEqual(await a.read(), { type: 'done', requestId: a.requestId, status: 'aborted' })
  assert.equal(await a.read(), undefined)
  assert.equal(calls.find(call => call.text === 'Bob text').signal.aborted, false)
  release()
  assert.deepEqual(await b.read(), { type: 'delta', requestId: b.requestId, text: ' done' })
  assert.deepEqual(await b.read(), { type: 'reply', requestId: b.requestId, text: 'Bob text done' })
  assert.deepEqual(await b.read(), { type: 'done', requestId: b.requestId, status: 'completed' })
  assert.equal(await b.read(), undefined)

  const laterRelease = hold('Alice later')
  const later = await send(alice, 'Alice later')
  assert.equal((await later.read()).text, 'Alice later')
  assert.equal(calls.find(call => call.text === 'Alice text').sessionId, calls.find(call => call.text === 'Alice later').sessionId)
  assert.equal((await request('cancel', cancellation, alice)).status, 403)
  laterRelease()
  await later.read()
  await later.read()
  assert.equal((await later.read()).status, 'completed')
})

test('private chat enforces origin and roster and drops buffered replies on logout', { timeout: 8000 }, async t => {
  const { handle, request, invite, hold, send, calls } = await fixture(t)
  const alice = await invite('alice')
  const text = { botId: 'helper', text: 'hello' }
  assert.equal((await request('send', text)).status, 401)
  assert.equal((await request('send', text, alice + '; ' + alice)).status, 401)
  assert.equal((await request('send', text, alice, { Origin: 'https://sibling.example.test' })).status, 403)
  assert.equal((await request('send', text, alice, { 'Sec-Fetch-Site': 'same-site' })).status, 403)
  assert.equal((await request('send', { ...text, personId: 'bob' }, alice)).status, 400)
  assert.equal((await request('send', { ...text, sessionId: 'native-id' }, alice)).status, 400)
  assert.equal((await request('send', { ...text, botId: 'private' }, alice)).status, 403)
  assert.equal((await request('send', { ...text, botId: 'unknown' }, alice)).status, 403)
  for (const [length, status] of [['d', 400], ['257', 413]]) {
    assert.equal((await request('send', text, alice, { 'Content-Length': length })).status, status)
  }
  assert.equal((await request('send', { ...text, text: 'a'.repeat(300) }, alice)).status, 413)
  assert.equal(calls.length, 0)
  const release = hold('logout text')
  const active = await send(alice, 'logout text')
  assert.equal((await active.read()).text, 'logout text')
  const queued = await send(alice, 'blocked in queue')
  assert.equal((await request('cancel', { botId: 'helper', requestId: queued.requestId }, alice)).status, 403)
  const logout = new Request(origin + '/api/enterprise/auth/logout', { method: 'POST', headers: { Origin: origin, Cookie: alice } })
  assert.equal((await handle(logout)).status, 204)
  assert.equal((await request('send', text, alice)).status, 401)
  assert.equal((await request('cancel', { botId: 'helper', requestId: active.requestId }, alice)).status, 401)
  release()
  assert.equal(await active.read(), undefined)
  assert.equal(await queued.read(), undefined)
  assert.deepEqual(calls.map(call => call.text), ['logout text'])
})

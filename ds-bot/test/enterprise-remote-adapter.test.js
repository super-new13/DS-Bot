import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRemoteWorkerAdapter } from '../src/host/enterprise/remote-adapter.js'
import { createEmployeePrivateChatHandler } from '../src/host/enterprise/private-chat-http.js'

const nodeId = 'node-a'
const logicalScope = { personId: 'alice', botId: 'helper', sessionKey: '["alice","helper"]' }
const origin = 'https://employees.example.test'
const unknownCode = 'worker-outcome-unknown'

function request(path, body) {
  return new Request(origin + '/api/enterprise/private-chat/' + path, {
    method: 'POST', body: JSON.stringify(body), headers: {
      origin, 'content-type': 'application/json', cookie: '__Host-dsbot-employee=' + 'a'.repeat(43),
    },
  })
}

test('binds create, submit, events and cancel to the same native scope and request', async () => {
  const calls = []
  const events = []
  const hold = Promise.withResolvers()
  const client = {
    create(scope) { calls.push(['create', scope]); return { sessionId: 'native-a' } },
    async submit(scope, requestId, text, { onEvent }) {
      calls.push(['submit', scope, requestId, text])
      onEvent({ requestId: 'foreign-id', type: 'delta', text })
      onEvent({ requestId, personId: 'bob', type: 'reply', text })
      onEvent({ requestId, type: 'reply', text })
      await hold.promise
      return { requestId, status: 'completed' }
    },
    async cancel(scope, requestId) { calls.push(['cancel', scope, requestId]); return { accepted: true } },
  }
  const worker = createRemoteWorkerAdapter({ nodeId, client })
  const [scope, repeated] = await Promise.all([worker.create(logicalScope), worker.create(logicalScope)])
  assert.equal(repeated, scope)
  const input = { ...scope, requestId: 'request-a', text: 'mock chat' }
  await assert.rejects(worker.submit({ ...input, nodeId: 'other' }), { code: 'not-authorized' })
  await assert.rejects(worker.submit({ ...input, sessionId: 'other' }), { code: 'not-authorized' })
  await assert.rejects(worker.create({ ...logicalScope, personId: 'bob' }), { code: 'not-authorized' })
  const submit = worker.submit(input, event => events.push(event))
  await assert.rejects(worker.cancel({ ...input, requestId: 'foreign-id' }), { code: 'not-authorized' })
  assert.deepEqual(await worker.cancel(input), { accepted: true })
  hold.resolve()
  assert.deepEqual(await submit, { requestId: 'request-a', sessionId: 'native-a', status: 'completed' })
  assert.deepEqual(events, [{ requestId: 'request-a', sessionId: 'native-a', type: 'reply', text: 'mock chat' }])
  const wire = { nodeId, personId: 'alice', botId: 'helper' }
  assert.deepEqual(calls, [['create', wire], ['submit', { ...wire, sessionId: 'native-a' }, 'request-a', 'mock chat'],
    ['cancel', { ...wire, sessionId: 'native-a' }, 'request-a']])
})

function fixture(worker) {
  let authorized = true
  const identity = { personId: 'alice', loginSessionId: 'login-a' }
  const roster = { people: { alice: { id: 'alice', botIds: ['helper'] } }, bots: { helper: { id: 'helper' } } }
  const handler = createEmployeePrivateChatHandler({ origin,
    accounts: { resolveSession: () => identity, isSessionActive: () => authorized },
    readRoster: () => roster, resolveBot: botId => ({ botId, nodeId, worker }),
    limits: { maxActive: 1, maxPerBot: 1, maxPerNode: 1, maxPending: 1 },
  })
  return { handler, revoke: () => { authorized = false } }
}

for (const [label, settle, revoke, expected] of [
  ['confirmed acknowledgment', gate => gate.resolve({ accepted: true }), false, 202],
  ['unknown acknowledgment', gate => gate.reject(new Error('private upstream detail')), false, 503],
  ['scope mismatch', gate => gate.resolve({ accepted: true, sessionId: 'foreign' }), false, 503],
  ['revocation before acknowledgment', gate => gate.resolve({ accepted: true }), true, 403],
  ['revocation before error', gate => gate.reject(new Error('private upstream detail')), true, 403],
]) {
  test('handles asynchronous cancel with ' + label, async () => {
    const submitStarted = Promise.withResolvers()
    const submitDone = Promise.withResolvers()
    const cancelStarted = Promise.withResolvers()
    const cancelAck = Promise.withResolvers()
    const client = {
      create: () => ({ sessionId: 'native-a' }),
      async submit(_scope, requestId) {
        submitStarted.resolve(requestId)
        await submitDone.promise
        return { requestId, status: 'completed' }
      },
      cancel(scope, requestId) {
        cancelStarted.resolve({ scope, requestId })
        return cancelAck.promise
      },
    }
    const { handler, revoke: revokeLogin } = fixture(createRemoteWorkerAdapter({ client, nodeId }))
    const stream = await handler(request('send', { botId: 'helper', text: 'hold turn' }))
    const requestId = await submitStarted.promise
    const stopping = handler(request('cancel', { botId: 'helper', requestId }))
    assert.equal((await cancelStarted.promise).requestId, requestId)
    if (revoke) revokeLogin()
    settle(cancelAck)
    const response = await stopping
    assert.equal(response.status, expected)
    if (expected === 503) assert.deepEqual(await response.json(), { error: unknownCode })
    if (expected === 202) assert.deepEqual(await response.json(), { accepted: true })
    submitDone.resolve()
    await stream.text()
  })
}

test('reports unconfirmed submit once even when the remote response claims completion for another request', async () => {
  let attempts = 0
  const client = {
    create: () => ({ sessionId: 'native-a' }), cancel() {},
    submit() { attempts++; return { requestId: 'foreign', status: 'completed' } },
  }
  const { handler } = fixture(createRemoteWorkerAdapter({ client, nodeId }))
  const response = await handler(request('send', { botId: 'helper', text: 'mock chat' }))
  const events = (await response.text()).trim().split('\n\n').map(frame => JSON.parse(frame.slice(6)))
  assert.equal(events[0].type, 'queued')
  assert.deepEqual(events[1], { type: 'error', requestId: events[0].requestId, code: unknownCode })
  assert.equal(events.length, 2)
  assert.equal(attempts, 1)
})

test('keeps synchronous local cancellation and terminal submit behavior', async () => {
  const started = Promise.withResolvers()
  const stopped = Promise.withResolvers()
  const worker = {
    create: scope => ({ ...scope, sessionId: 'local-a' }),
    async submit({ sessionId, requestId }) {
      started.resolve(requestId)
      await stopped.promise
      return { requestId, sessionId, status: 'aborted' }
    },
    cancel() { stopped.resolve(); return { accepted: true } },
  }
  const { handler } = fixture(worker)
  const stream = await handler(request('send', { botId: 'helper', text: 'local fixture' }))
  const requestId = await started.promise
  const result = await handler(request('cancel', { botId: 'helper', requestId }))
  assert.equal(result.status, 202)
  assert.deepEqual(await result.json(), { accepted: true })
  const events = (await stream.text()).trim().split('\n\n').map(frame => JSON.parse(frame.slice(6)))
  assert.deepEqual(events, [{ type: 'queued', requestId }, { type: 'done', requestId, status: 'aborted' }])
})

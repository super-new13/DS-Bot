import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createWorkerHttpHandler } from '../src/host/enterprise/worker-http.js'
import { openWorkerReceipts } from '../src/host/enterprise/worker-receipts.js'

const origin = 'https://worker.example.test'
const transport = Object.freeze({})
const observer = Object.freeze({})
const scope = { nodeId: 'node-a', botId: 'helper', personId: 'alice' }
const requestId = 'operation-1'

function request(action, input, { method = 'POST', headers = {} } = {}) {
  return new Request(origin + '/internal/enterprise/worker/' + action, {
    method, ...(method === 'GET' ? {} : { body: JSON.stringify(input) }),
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

async function fixture() {
  let state = { version: 1, generation: null, receipts: {} }
  let queue = Promise.resolve()
  const storage = {
    read: () => structuredClone(state), now: () => 42,
    transact(change) {
      const result = queue.then(() => {
        const next = structuredClone(state)
        const value = change(next)
        state = next
        return value
      })
      queue = result.catch(() => {})
      return result
    },
  }
  const receipts = await openWorkerReceipts(storage)
  const gate = Promise.withResolvers()
  const active = new Map()
  const calls = []
  let nextId = 0
  let revoked = false
  const worker = {
    async create(input) { return { ...input, sessionId: 'session-' + ++nextId } },
    async submit(input, onEvent) {
      calls.push(input)
      active.set(input.requestId, input)
      onEvent({ type: 'delta', text: 'forged event', sessionId: 'other-session', requestId: input.requestId })
      onEvent({ type: 'delta', text: 'other request', sessionId: input.sessionId, requestId: 'other-operation' })
      onEvent({ type: 'delta', text: 'reply', sessionId: input.sessionId, requestId: input.requestId, internal: 'not projected' })
      try {
        const status = await gate.promise
        return { sessionId: input.sessionId, requestId: input.requestId, status }
      } finally { active.delete(input.requestId) }
    },
    cancel(input) {
      if (active.get(input.requestId)?.sessionId !== input.sessionId) return undefined
      gate.resolve('aborted')
      return { accepted: true }
    },
  }
  const handler = (book = receipts) => createWorkerHttpHandler({
    origin, nodeId: scope.nodeId, maxBodyBytes: 256, maxActive: 1, worker, receipts: book,
    authenticatePeer: metadata => metadata === transport ? 'controller' : metadata === observer ? 'observer' : undefined,
    authorizePeer: (peer, { action, scope: target }) => !revoked && (peer === 'controller' || action === 'status')
      && target.nodeId === scope.nodeId && target.botId === scope.botId && target.personId === scope.personId,
  })
  const fetch = handler()
  const call = (action, input, metadata = transport, options) => fetch(request(action, input, options), metadata)
  async function create() {
    const response = await call('create', scope)
    assert.equal(response.status, 201)
    return { ...scope, ...await response.json(), requestId }
  }
  return { call, create, receipts, storage, handler, calls, gate, revoke: () => { revoked = true } }
}

function readFrame(reader) {
  return reader.read().then(({ done, value }) => done ? undefined : JSON.parse(new TextDecoder().decode(value)))
}

test('worker admits once, streams matching frames and cancels only the exact active operation', { timeout: 3000 }, async () => {
  const { call, create, calls } = await fixture()
  const keys = await create()
  const input = { ...keys, text: 'mock prompt' }
  const submitted = await call('submit', input, transport, { headers: { 'Content-Length': String(Buffer.byteLength(JSON.stringify(input))) } })
  assert.equal(submitted.status, 202)
  assert.equal(submitted.headers.get('Content-Type'), 'application/x-ndjson')
  const reader = submitted.body.getReader()
  const initial = { requestId, status: 'admitted', admittedAt: 42 }
  assert.deepEqual(await readFrame(reader), { type: 'receipt', receipt: initial })
  assert.deepEqual(await readFrame(reader), { type: 'delta', requestId, text: 'reply' })
  assert.deepEqual(await (await call('status', keys, observer)).json(), { receipt: initial })
  assert.deepEqual(await (await call('submit', input)).json(), { receipt: initial })
  assert.equal((await call('submit', { ...input, text: 'changed' })).status, 409)
  assert.equal((await call('submit', { ...input, requestId: 'another-operation' })).status, 409)
  assert.equal((await call('cancel', keys, observer)).status, 403)
  assert.equal((await call('cancel', { ...keys, sessionId: 'other-session' })).status, 403)
  assert.equal((await call('cancel', { ...keys, requestId: 'foreign-operation' })).status, 403)
  assert.equal((await call('cancel', keys)).status, 202)
  const terminal = { ...initial, status: 'aborted', finishedAt: 42 }
  assert.deepEqual(await readFrame(reader), { type: 'receipt', receipt: terminal })
  assert.equal(await readFrame(reader), undefined)
  assert.deepEqual(await (await call('status', keys)).json(), { receipt: terminal })
  assert.equal((await call('cancel', keys)).status, 403)
  assert.deepEqual(calls.map(call => call.requestId), [requestId])
})

test('worker requires out-of-band peer identity and bounds its explicit actions and inputs', async () => {
  const { call, create, calls } = await fixture()
  assert.equal((await call('create', scope, {}, { headers: { 'X-Worker-Peer': 'controller' } })).status, 403)
  assert.equal((await call('create', { ...scope, peer: 'controller' })).status, 400)
  assert.equal((await call('create', scope, observer)).status, 403)
  assert.equal((await call('tool', scope)).status, 404)
  assert.equal((await call('create', scope, transport, { method: 'GET' })).status, 405)
  assert.equal((await call('create', scope, transport, { headers: { 'Content-Length': 'd' } })).status, 400)
  assert.equal((await call('create', scope, transport, { headers: { 'Content-Length': '257' } })).status, 413)
  const keys = await create()
  assert.equal((await call('submit', { ...keys, text: 'x'.repeat(256) })).status, 413)
  assert.equal((await call('submit', { ...keys, nodeId: 'node-b', text: 'mock prompt' })).status, 403)
  assert.equal((await call('status', { ...keys, nodeId: 'node-b' })).status, 403)
  assert.equal((await call('status', { ...keys, personId: 'bob' })).status, 403)
  assert.equal(calls.length, 0)
})

test('status projects the exact receipt after restart and resubmission does not replay unknown work', async () => {
  const { create, receipts, storage, handler, calls } = await fixture()
  const keys = await create()
  const text = 'mock lost response'
  await receipts.admit(keys, requestId, createHash('sha256').update(text, 'utf16le').digest('hex'))
  const restarted = handler(await openWorkerReceipts(storage))
  const status = await restarted(request('status', keys), transport)
  assert.deepEqual(await status.json(), { receipt: { requestId, admittedAt: 42, status: 'unknown' } })
  const foreign = await restarted(request('status', { ...keys, sessionId: 'elsewhere' }), transport)
  assert.equal(foreign.status, 404)
  const duplicate = await restarted(request('submit', { ...keys, text }), transport)
  assert.equal(duplicate.status, 200)
  assert.equal((await duplicate.json()).receipt.status, 'unknown')
  assert.equal(calls.length, 0)
})

test('unverified worker failure is unknown and does not restart execution', { timeout: 3000 }, async () => {
  const { create, call, gate, calls } = await fixture()
  const keys = await create()
  const input = { ...keys, text: 'mock prompt' }
  const reader = (await call('submit', input)).body.getReader()
  assert.equal((await readFrame(reader)).receipt.status, 'admitted')
  assert.equal((await readFrame(reader)).type, 'delta')
  gate.reject(new Error('fixture lost its worker'))
  assert.equal((await readFrame(reader)).receipt.status, 'unknown')
  assert.equal(await readFrame(reader), undefined)
  assert.equal((await (await call('status', keys)).json()).receipt.status, 'unknown')
  assert.equal((await (await call('submit', input)).json()).receipt.status, 'unknown')
  assert.equal(calls.length, 1)
})

test('revoked peer cannot read queued stream frames or submit another action', { timeout: 3000 }, async () => {
  const { create, call, gate, revoke } = await fixture()
  const keys = await create()
  const response = await call('submit', { ...keys, text: 'mock prompt' })
  const reader = response.body.getReader()
  assert.equal((await readFrame(reader)).receipt.status, 'admitted')
  revoke()
  assert.equal(await readFrame(reader), undefined)
  assert.equal((await call('status', keys)).status, 403)
  assert.equal((await call('cancel', keys)).status, 403)
  gate.resolve('completed')
})

test('room routing shares a Session key while receipts and cancellation remain actor scoped', { timeout: 3000 }, async () => {
  const { receipts } = await fixture()
  const calls = []
  const grants = []
  const gate = Promise.withResolvers()
  const expectedKey = JSON.stringify(['room', scope.nodeId, scope.botId, 'general'])
  const room = { ...scope, roomId: 'general' }
  const bob = { ...room, personId: 'bob' }
  const handle = createWorkerHttpHandler({ nodeId: scope.nodeId, origin, receipts, allowRooms: true,
    authenticatePeer: peer => peer === transport ? 'controller' : undefined,
    authorizePeer(peer, { scope: target }) {
      grants.push(target)
      return peer === 'controller' && [undefined, 'general', 'adjacent'].includes(target.roomId)
    },
    worker: {
      create(input) {
        calls.push(input)
        return { ...input, sessionId: input.sessionKey === expectedKey ? 'shared' : 'private' }
      },
      async submit(input) {
        calls.push(input)
        if (input.sessionKey !== expectedKey || input.sessionId !== 'shared') throw new Error('Scope mismatch')
        const status = await gate.promise
        return { ...input, status }
      },
      cancel(input) {
        calls.push(input)
        gate.resolve('aborted')
        return { accepted: true }
      },
    },
  })
  const call = (action, payload) => handle(request(action, payload), transport)
  for (const roomId of ['', null, '../general', 1]) {
    assert.equal((await call('create', { ...scope, roomId })).status, 400)
  }
  assert.equal(grants.length, 0)
  for (const actor of [room, bob]) {
    const response = await call('create', actor)
    assert.equal(response.status, 201)
    assert.deepEqual(await response.json(), { sessionId: 'shared' })
    assert.equal(calls.at(-1).sessionKey, expectedKey)
    assert.equal(calls.at(-1).personId, actor.personId)
    assert.deepEqual(grants.at(-1), actor)
  }
  assert.deepEqual(await (await call('create', scope)).json(), { sessionId: 'private' })
  assert.deepEqual(calls.at(-1), { botId: scope.botId, personId: scope.personId, sessionId: undefined,
    sessionKey: JSON.stringify([scope.nodeId, scope.botId, scope.personId]),
  })
  const active = { ...room, sessionId: 'shared', requestId: 'active-room' }
  const response = await call('submit', { ...active, text: 'room prompt' })
  assert.equal(response.status, 202)
  const reader = response.body.getReader()
  assert.equal((await readFrame(reader)).receipt.status, 'admitted')
  assert.equal((await call('status', active)).status, 200)
  const privateScope = { ...scope, sessionId: active.sessionId, requestId: active.requestId }
  const foreignScopes = [{ ...active, personId: 'bob' }, privateScope,
    { ...active, sessionId: 'private' }, { ...active, roomId: 'adjacent' },
  ]
  for (const foreign of foreignScopes) {
    assert.equal((await call('status', foreign)).status, 404)
    assert.equal((await call('cancel', foreign)).status, 403)
    assert.equal((await call('submit', { ...foreign, text: 'room prompt' })).status, 409)
  }
  const foreignRoom = { ...active, roomId: 'other' }
  assert.equal((await call('status', foreignRoom)).status, 403)
  assert.equal((await call('cancel', foreignRoom)).status, 403)
  assert.equal((await call('cancel', active)).status, 202)
  assert.equal(calls.at(-1).personId, 'alice')
  assert.equal(calls.at(-1).roomId, room.roomId)
  assert.equal((await readFrame(reader)).receipt.status, 'aborted')
  assert.equal(await readFrame(reader), undefined)
  assert.equal((await call('status', { ...active, personId: 'bob' })).status, 404)
  const next = { ...active, personId: 'bob', requestId: 'bob-room-request' }
  const nextResponse = await call('submit', { ...next, text: 'second actor' })
  assert.equal(nextResponse.status, 202)
  await nextResponse.text()
  assert.equal(calls.at(-1).sessionKey, expectedKey)
  assert.equal(calls.at(-1).personId, 'bob')
  assert.equal((await call('status', next)).status, 200)
  assert.equal((await call('status', { ...next, personId: 'alice' })).status, 404)
})

test('private-only worker refuses valid room actions before authorization or storage', async () => {
  const calls = []
  const record = name => () => { calls.push(name); return true }
  const options = {
    nodeId: scope.nodeId, origin,
    authenticatePeer: peer => peer === transport ? 'controller' : undefined,
    authorizePeer: record('authorizePeer'),
    worker: { create: record('create'), submit: record('submit'), cancel: record('cancel') },
    receipts: { lookup: record('lookup'), admit: record('admit'), finish: record('finish') },
  }
  assert.throws(() => createWorkerHttpHandler({ ...options, allowRooms: 'true' }), /Invalid worker HTTP configuration/)
  const handle = createWorkerHttpHandler(options)
  const room = { ...scope, roomId: 'general' }
  const operation = { ...room, sessionId: 'private-session', requestId: 'room-request' }
  for (const [action, input] of [['create', room], ['submit', { ...operation, text: 'mock prompt' }],
    ['status', operation], ['cancel', operation],
  ]) {
    const response = await handle(request(action, input), transport)
    assert.equal(response.status, 403, action)
    assert.deepEqual(await response.json(), { error: 'worker-refused' })
  }
  const malformed = await handle(request('create', { ...room, roomId: '' }), transport)
  assert.equal(malformed.status, 400)
  assert.deepEqual(calls, [])
})

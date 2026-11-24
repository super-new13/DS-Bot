import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkerClient } from '../src/host/enterprise/worker-client.js'
import { createWorkerHttpHandler } from '../src/host/enterprise/worker-http.js'
import { openWorkerReceipts } from '../src/host/enterprise/worker-receipts.js'

const origin = 'https://worker.example.test'
const scope = { nodeId: 'node-a', botId: 'bot-a', personId: 'person-a', sessionId: 'session-a' }
const requestId = 'request-a'
const admission = { requestId, admittedAt: 5, status: 'admitted' }
const completed = { requestId, admittedAt: 5, finishedAt: 5, status: 'completed' }
const unknown = { ...admission, status: 'unknown' }
const encoder = new TextEncoder()
const receiptFrame = receipt => ({ type: 'receipt', receipt })
const frameLine = frame => JSON.stringify(frame) + String.fromCharCode(10)
const delta = { requestId, type: 'delta', text: 'mock café' }

async function pair() {
  let state = { version: 1, generation: null, receipts: {} }
  const receipts = await openWorkerReceipts({
    read: () => structuredClone(state), now: () => 5,
    transact(change) {
      const next = structuredClone(state)
      const result = change(next)
      state = next
      return result
    },
  })
  const peer = Object.freeze({})
  const lifetime = Promise.withResolvers()
  const calls = []
  let active
  const worker = {
    create: async input => ({ ...input, sessionId: scope.sessionId }),
    async submit(input, onEvent) {
      active = input
      onEvent({ ...delta, sessionId: input.sessionId })
      const status = await lifetime.promise
      active = undefined
      return { requestId: input.requestId, sessionId: input.sessionId, status }
    },
    cancel(input) {
      assert.equal(input.requestId, active.requestId)
      assert.equal(input.sessionId, active.sessionId)
      lifetime.resolve('aborted')
      return { accepted: true }
    },
  }
  const handle = createWorkerHttpHandler({
    nodeId: scope.nodeId, origin, worker, receipts,
    authenticatePeer: transport => transport === peer ? 'controller' : undefined,
    authorizePeer: (identity, { scope: target }) => identity === 'controller' && target.personId === scope.personId,
  })
  const client = createWorkerClient({ nodeId: scope.nodeId, origin, transport: async request => {
    assert.equal(request.redirect, 'error')
    const action = new URL(request.url).pathname.split('/').at(-1)
    calls.push(action)
    return handle(request, peer)
  } })
  return { client, calls, lifetime }
}

function scriptedClient(chunks, { endWithError = false, ...limits } = {}) {
  const calls = []
  let cancelled = false
  const client = createWorkerClient({ nodeId: scope.nodeId, origin, ...limits, transport: request => {
    calls.push(new URL(request.url).pathname.split('/').at(-1))
    let offset = 0
    const body = new ReadableStream({
      pull(controller) {
        if (offset < chunks.length) controller.enqueue(chunks[offset++])
        else if (endWithError) controller.error(new Error('mock connection interrupted'))
        else controller.close()
      },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 })
    return new Response(body, { status: 202, headers: { 'Content-Type': 'application/x-ndjson' } })
  } })
  return { client, calls, cancelled: () => cancelled }
}

test('worker client pairs with handler for create, submit, status and cancel', { timeout: 3000 }, async () => {
  const { client, calls } = await pair()
  assert.deepEqual(await client.create(scope), { sessionId: scope.sessionId })
  const first = Promise.withResolvers()
  const submitted = client.submit(scope, requestId, 'mock prompt', { onEvent: first.resolve })
  assert.deepEqual(await first.promise, delta)
  assert.deepEqual(await client.status(scope, requestId), admission)
  assert.deepEqual(await client.cancel(scope, requestId), { accepted: true })
  const aborted = { ...completed, status: 'aborted' }
  assert.deepEqual(await submitted, aborted)
  assert.deepEqual(await client.status(scope, requestId), aborted)
  assert.deepEqual(await client.submit(scope, requestId, 'mock prompt'), aborted)
  assert.deepEqual(await client.status({ ...scope, sessionId: 'other' }, requestId), { requestId, status: 'unknown' })
  await assert.rejects(client.status({ ...scope, personId: 'other' }, requestId), { code: 'worker-refused', status: 403 })
  await assert.rejects(client.status({ ...scope, nodeId: 'other' }, requestId), TypeError)
  assert.deepEqual(calls, ['create', 'submit', 'status', 'cancel', 'status', 'submit', 'status', 'status'])
})

test('worker client reads split UTF-8 frames and requires a clean terminal stream', async () => {
  const data = encoder.encode([receiptFrame(admission), delta, receiptFrame(completed)].map(frameLine).join(''))
  const chunks = Array.from(data, value => Uint8Array.of(value))
  const { client, calls } = scriptedClient(chunks)
  const events = []
  assert.deepEqual(await client.submit(scope, requestId, 'hello', { onEvent: event => events.push(event) }), completed)
  assert.deepEqual(events, [delta])
  assert.deepEqual(calls, ['submit'])
  const broken = scriptedClient(chunks, { endWithError: true })
  assert.deepEqual(await broken.client.submit(scope, requestId, 'hello'), unknown)
  assert.deepEqual(broken.calls, ['submit'])
})

test('worker client suppresses cross-request frames and drops incomplete outcomes without retrying', async () => {
  const first = encoder.encode(frameLine(receiptFrame(admission)))
  const scenarios = [
    [encoder.encode(frameLine({ ...delta, requestId: 'other-request' }))],
    [encoder.encode(frameLine({ ...delta, sessionId: 'other-session' }))],
    [encoder.encode(frameLine(receiptFrame({ ...completed, requestId: 'other-request' })))],
    [encoder.encode(frameLine(receiptFrame(completed)).slice(0, -1))],
    [encoder.encode(frameLine(receiptFrame(completed))), encoder.encode(frameLine(delta))],
    [],
  ]
  for (const chunks of scenarios) {
    const { client, calls } = scriptedClient([first, ...chunks])
    const events = []
    assert.deepEqual(await client.submit(scope, requestId, 'hello', { onEvent: event => events.push(event) }), unknown)
    assert.deepEqual(events, [])
    assert.deepEqual(calls, ['submit'])
  }
})

test('worker client limits buffered JSON, individual frames and total stream bytes', async () => {
  const first = encoder.encode(frameLine(receiptFrame(admission)))
  const text = encoder.encode(frameLine(delta))
  const overFrame = scriptedClient([first, encoder.encode('x'.repeat(129))], { maxFrameBytes: 128 })
  assert.deepEqual(await overFrame.client.submit(scope, requestId, 'hello'), unknown)
  assert.equal(overFrame.cancelled(), true)
  const overStream = scriptedClient([first, text, text], { maxFrameBytes: 128, maxStreamBytes: first.length + text.length })
  const events = []
  assert.deepEqual(await overStream.client.submit(scope, requestId, 'hello', { onEvent: event => events.push(event) }), unknown)
  assert.deepEqual(events, [delta])
  assert.equal(overStream.cancelled(), true)
  const bigJson = createWorkerClient({ nodeId: scope.nodeId, origin, transport: () => Response.json({ sessionId: 'x'.repeat(5000) }, { status: 201 }) })
  await assert.rejects(bigJson.create(scope), { code: 'worker-outcome-unknown' })
})

test('worker client never resubmits after transport loss and rejects a foreign receipt in status', async () => {
  const calls = []
  const client = createWorkerClient({ nodeId: scope.nodeId, origin, transport: request => {
    const action = new URL(request.url).pathname.split('/').at(-1)
    calls.push(action)
    if (action === 'submit') throw new Error('mock connection reset')
    return Response.json({ receipt: { ...completed, requestId: 'other' } })
  } })
  assert.deepEqual(await client.submit(scope, requestId, 'hello'), { requestId, status: 'unknown' })
  assert.deepEqual(calls, ['submit'])
  assert.deepEqual(await client.status(scope, requestId), { requestId, status: 'unknown' })
  assert.deepEqual(calls, ['submit', 'status'])
})

test('worker client carries the room and actor separately on every wire action', async () => {
  const calls = []
  const room = { ...scope, roomId: 'general' }
  const client = createWorkerClient({ nodeId: scope.nodeId, origin, async transport(request) {
    const action = new URL(request.url).pathname.split('/').at(-1)
    calls.push([action, await request.json()])
    if (action === 'create') return Response.json({ sessionId: scope.sessionId }, { status: 201 })
    if (action === 'cancel') return Response.json({ accepted: true }, { status: 202 })
    return Response.json({ receipt: completed })
  } })
  await client.create(room)
  await client.submit(room, requestId, 'room prompt')
  await client.status(room, requestId)
  await client.cancel(room, requestId)
  const { sessionId, ...creation } = room
  assert.deepEqual(calls, [
    ['create', creation], ['submit', { ...room, requestId, text: 'room prompt' }],
    ['status', { ...room, requestId }], ['cancel', { ...room, requestId }],
  ])
  for (const roomId of ['', null, '../general', undefined]) {
    assert.throws(() => client.create({ ...room, roomId }), TypeError)
    await assert.rejects(client.submit({ ...room, roomId }, requestId, 'room prompt'), TypeError)
  }
  await client.create(scope)
  assert.deepEqual(calls.at(-1), ['create', { nodeId: scope.nodeId, botId: scope.botId, personId: scope.personId }])
})

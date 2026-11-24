import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { createDispatchQueue } from '../src/host/enterprise/dispatch-queue.js'

function request(requestId, overrides) {
  return { requestId, sessionKey: requestId, personId: 'employee', botId: 'bot-a', nodeId: 'node-a', ...overrides }
}

function fixture(options) {
  const turns = new Map()
  const started = []
  const queue = createDispatchQueue({
    maxActive: 3,
    maxPerBot: 2,
    maxPerNode: 3,
    maxPending: 4,
    authorize: () => true,
    execute: ({ requestId }) => {
      started.push(requestId)
      const turn = Promise.withResolvers()
      turns.set(requestId, turn)
      return turn.promise
    },
    ...options,
  })
  return { ...queue, started, turns, finish: id => turns.get(id).resolve(id) }
}

test('serializes a logical session while another session of the same Bot runs', async () => {
  const { enqueue, started, finish } = fixture()
  const first = enqueue(request('first', { sessionKey: 'alice-chat' }))
  const second = enqueue(request('second', { sessionKey: 'alice-chat' }))
  const third = enqueue(request('third', { sessionKey: 'alice-chat' }))
  const other = enqueue(request('other', { sessionKey: 'bob-chat', personId: 'bob' }))
  await setImmediate()
  assert.deepEqual(started, ['first', 'other'])
  finish('first')
  assert.equal(await first, 'first')
  await setImmediate()
  assert.deepEqual(started, ['first', 'other', 'second'])
  finish('second')
  await second
  await setImmediate()
  assert.deepEqual(started, ['first', 'other', 'second', 'third'])
  finish('third')
  finish('other')
  await Promise.all([third, other])
})

for (const [name, options, blocked, independent] of [
  ['Bot', { maxPerBot: 1 }, { nodeId: 'node-b' }, { botId: 'bot-b' }],
  ['node', { maxPerNode: 1 }, { botId: 'bot-b' }, { nodeId: 'node-b' }],
  ['global', { maxActive: 1 }, { botId: 'bot-b', nodeId: 'node-b' }, null],
]) {
  test('enforces the ' + name + ' limit across separate sessions', async () => {
    const { enqueue, started, finish } = fixture(options)
    const first = enqueue(request('first'))
    const second = enqueue(request('second', blocked))
    const other = independent && enqueue(request('other', independent))
    await setImmediate()
    assert.deepEqual(started, independent ? ['first', 'other'] : ['first'])
    finish('first')
    await first
    await setImmediate()
    assert.equal(started.at(-1), 'second')
    finish('second')
    if (other) finish('other')
    await Promise.all([second, other])
  })
}

test('does not overtake an older request in the same session when routing differs', async () => {
  const { enqueue, started, finish } = fixture({ maxPerNode: 1 })
  const blocker = enqueue(request('blocker'))
  const older = enqueue(request('older', { sessionKey: 'chat' }))
  const newer = enqueue(request('newer', { sessionKey: 'chat', nodeId: 'node-b' }))
  await setImmediate()
  assert.deepEqual(started, ['blocker'])
  finish('blocker')
  await blocker
  await setImmediate()
  assert.deepEqual(started, ['blocker', 'older'])
  finish('older')
  await older
  await setImmediate()
  assert.deepEqual(started, ['blocker', 'older', 'newer'])
  finish('newer')
  await newer
})

test('limits pending requests and recovers space as requests advance', async () => {
  const { enqueue, started, finish } = fixture({ maxActive: 1, maxPending: 1 })
  const first = enqueue(request('first'))
  const second = enqueue(request('second'))
  await assert.rejects(enqueue(request('overflow')), { code: 'queue-full' })
  await setImmediate()
  finish('first')
  await first
  const third = enqueue(request('third'))
  await setImmediate()
  assert.deepEqual(started, ['first', 'second'])
  finish('second')
  await second
  await setImmediate()
  assert.deepEqual(started, ['first', 'second', 'third'])
  finish('third')
  await third
})

test('rechecks live access at dispatch and skips revoked work in a shared session', async () => {
  const allowed = new Set(['employee', 'bob'])
  const checked = []
  const { enqueue, started, finish } = fixture({ authorize: async ({ requestId, personId }) => {
    checked.push(requestId)
    return allowed.has(personId)
  } })
  const first = enqueue(request('first', { sessionKey: 'room' }))
  const revoked = enqueue(request('revoked', { sessionKey: 'room' }))
  const refused = assert.rejects(revoked, { code: 'not-authorized' })
  const next = enqueue(request('next', { sessionKey: 'room', personId: 'bob' }))
  await setImmediate()
  assert.deepEqual(checked, ['first'])
  allowed.delete('employee')
  finish('first')
  await Promise.all([first, refused])
  await setImmediate()
  assert.deepEqual(checked, ['first', 'revoked', 'next'])
  assert.deepEqual(started, ['first', 'next'])
  finish('next')
  await next
})

test('counts in-flight authorization and releases quota after callback errors', async () => {
  const gate = Promise.withResolvers()
  const unavailable = new Error('authorization unavailable')
  const executionFailed = new Error('execution failed')
  const executed = []
  const queue = createDispatchQueue({
    maxActive: 1, maxPerBot: 1, maxPerNode: 1, maxPending: 1,
    authorize: ({ requestId }) => requestId === 'first' ? gate.promise : true,
    execute: ({ requestId }) => {
      executed.push(requestId)
      if (requestId === 'second') throw executionFailed
      return requestId
    },
  })
  const first = assert.rejects(queue.enqueue(request('first')), error => error === unavailable)
  const second = assert.rejects(queue.enqueue(request('second')), error => error === executionFailed)
  await assert.rejects(queue.enqueue(request('overflow')), { code: 'queue-full' })
  assert.deepEqual(executed, [])
  gate.reject(unavailable)
  await Promise.all([first, second])
  assert.equal(await queue.enqueue(request('third')), 'third')
  assert.deepEqual(executed, ['second', 'third'])
})

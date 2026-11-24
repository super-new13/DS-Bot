import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRemoteWorkerAdapter } from '../src/host/enterprise/remote-adapter.js'
import { createRoomExecutor } from '../src/host/enterprise/room-executor.js'
import { createWorkerClient } from '../src/host/enterprise/worker-client.js'

const nodes = 'worker'
const roster = {
  rooms: { general: { people: ['alice', 'bob'], members: ['helper'] } },
  people: { alice: { name: 'Alice' }, bob: { name: 'Bob' }, outside: { name: 'Outside' } },
  bots: { helper: { nodeId: nodes } },
}
const roomBots = { general: 'helper' }
const message = (by, requestId, text = 'fixture message') => ({
  roomId: 'general', requestId, text, source: { by, name: roster.people[by].name },
})

function fixture() {
  const calls = []
  const client = createWorkerClient({ origin: 'https://worker.invalid', nodeId: nodes, async transport(request) {
    const action = request.url.split('/').at(-1)
    const body = await request.json()
    calls.push({ action, ...body })
    const sessionId = body.roomId ? 'room-session' : 'private-session'
    if (action === 'create') return Response.json({ sessionId }, { status: 201 })
    assert.equal(action, 'submit')
    assert.equal(body.sessionId, sessionId)
    const { requestId, text } = body
    const receipt = status => ({ type: 'receipt', receipt: { requestId, status, admittedAt: 1,
      ...(status === 'completed' ? { finishedAt: 2 } : {}),
    } })
    const reply = text === 'oversized' ? '界'.repeat(22000) : body.personId + ' reply'
    const events = [receipt('admitted'), { type: 'delta', requestId, text: 'draft' }, { type: 'reply', requestId, text: reply }]
    if (text !== 'disconnect') events.push(receipt('completed'))
    return new Response(events.map(event => JSON.stringify(event)).join(String.fromCharCode(10)) + String.fromCharCode(10),
      { status: 202, headers: { 'Content-Type': 'application/x-ndjson' } })
  } })
  const clients = new Map([[nodes, client]])
  return { calls, client, clients, execute: createRoomExecutor({ roster, roomBots, clients }) }
}

test('two actors share a room session and preserve their own request scopes', async () => {
  const { execute, calls, client } = fixture()
  assert.deepEqual(await execute(message('alice', 'first')), { roomId: 'general', by: 'helper', name: 'helper', text: 'alice reply' })
  assert.equal((await execute(message('bob', 'second'))).text, 'bob reply')
  const privateWorker = createRemoteWorkerAdapter({ nodeId: nodes, client })
  const scope = await privateWorker.create({ sessionKey: JSON.stringify(['alice', 'helper']), personId: 'alice', botId: 'helper' })
  assert.equal((await privateWorker.submit({ ...scope, requestId: 'private', text: 'private fixture' })).status, 'completed')
  assert.deepEqual(calls.map(({ action, roomId, personId, requestId, sessionId }) => [action, roomId, personId, requestId, sessionId]), [
    ['create', 'general', 'alice', undefined, undefined], ['submit', 'general', 'alice', 'first', 'room-session'],
    ['create', 'general', 'bob', undefined, undefined], ['submit', 'general', 'bob', 'second', 'room-session'],
    ['create', undefined, 'alice', undefined, undefined], ['submit', undefined, 'alice', 'private', 'private-session'],
  ])
})

test('foreign rooms, actors and unsupported Bot routing are refused before transport', async () => {
  const { execute, calls, clients } = fixture()
  await assert.rejects(execute({ ...message('alice', 'first'), roomId: 'foreign' }), { code: 'not-authorized' })
  await assert.rejects(execute(message('outside', 'first')), { code: 'not-authorized' })
  await assert.rejects(execute({ ...message('alice', 'first'), source: { by: 'alice', name: 'Bob' } }), { code: 'not-authorized' })
  assert.throws(() => createRoomExecutor({ roster, roomBots: { general: 'foreign' }, clients }), /single configured worker Bot/)
  assert.throws(() => createRoomExecutor({ roster: { ...roster,
    rooms: { general: { ...roster.rooms.general, members: ['helper', 'other'] } } }, roomBots, clients }), /single configured worker Bot/)
  assert.deepEqual(calls, [])
})

test('a lost outcome is surfaced without resend and oversized replies are omitted', async () => {
  const { execute, calls } = fixture()
  await assert.rejects(execute(message('alice', 'lost', 'disconnect')), { code: 'worker-outcome-unknown' })
  assert.deepEqual(calls.map(call => call.action), ['create', 'submit'])
  assert.equal(calls[1].requestId, 'lost')
  assert.equal(await execute(message('bob', 'big', 'oversized')), undefined)
  assert.equal(calls.length, 4)
})

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createEmployeeApi } from '../src/client/enterprise/api.js'
import { createEmployeeGroupChatHandler } from '../src/host/enterprise/group-chat-http.js'
import { createEmployeeGroupRuntime } from '../src/host/enterprise/group-runtime.js'
import { openEmployeeGroupStore } from '../src/host/enterprise/group-store.js'
import { createRoomExecutor } from '../src/host/enterprise/room-executor.js'
import { createEnterpriseRuntimeRoster } from '../src/host/enterprise/runtime-roster.js'

const origin = 'https://employee.invalid'
const source = Object.freeze({ by: 'alice', name: 'Alice' })
const input = Object.freeze({ roomId: 'general', requestId: 'round-1', text: 'Discuss', source })

function fixture({ mode = 'admin', reply } = {}) {
  const config = {
    people: { alice: { id: 'alice', name: 'Alice', botIds: [] }, outsider: { id: 'outsider', name: 'Outside', botIds: [] } },
    bots: { writer: { id: 'writer', name: 'Writer', nodeId: 'node-a' }, lead: { id: 'lead', name: 'Lead', nodeId: 'node-b' } },
    rooms: { general: { id: 'general', people: ['alice'], members: ['writer', 'lead'], admin: 'lead', mode } },
  }
  const { readRoster } = createEnterpriseRuntimeRoster({ readConfig: () => config, workers: new Map() })
  const calls = []
  const clients = new Map(['node-a', 'node-b'].map(nodeId => [nodeId, {
    async create(scope) { return { sessionId: scope.botId + '-room' } },
    async submit(scope, requestId, text, { onEvent }) {
      assert.equal(scope.nodeId, nodeId)
      calls.push({ scope, requestId, text })
      const outcome = await reply?.(scope.botId)
      onEvent({ type: 'reply', requestId, text: scope.botId + ' reply' })
      return { requestId, status: outcome ?? 'completed' }
    },
  }]))
  const execute = createRoomExecutor({ roster: readRoster(), readRoster, roomBots: { general: ['lead', 'writer'] }, clients })
  return { config, readRoster, execute, calls }
}

test('native plain policy and ordered replies use scoped Bots and immutable actor attribution', async () => {
  const { config, readRoster, execute, calls } = fixture()
  const replies = []
  const controls = { authorize: () => true, publish: reply => replies.push(reply) }
  await execute(input, controls)
  assert.deepEqual(calls.map(call => call.scope.botId), ['lead'])
  config.rooms.general.mode = 'everyone'
  await execute(input, controls)
  assert.deepEqual(calls.slice(1).map(call => call.scope.botId), ['lead', 'writer'])
  assert.deepEqual(calls.at(-1).scope, { nodeId: 'node-a', botId: 'writer', roomId: 'general', personId: 'alice', sessionId: 'writer-room' })
  assert.notEqual(calls.at(-1).requestId, calls[1].requestId)
  assert.match(calls.at(-1).text, /Lead: lead reply/)
  assert.equal(calls[1].requestId, calls[0].requestId)
  assert.equal(replies.at(-1).name, 'Writer')
  await execute({ ...input, opener: { quiet: true } }, controls)
  assert.equal(calls.length, 3)
  await assert.rejects(execute({ ...input, source: { by: 'outsider', name: 'Outside' } }, controls), { code: 'not-authorized' })
  config.rooms.general.admin = 'outsider'
  assert.throws(readRoster, /room reply policy/)
})

test('named and all calls start together, publish in completion order and never retry unknown', async () => {
  const gates = { writer: Promise.withResolvers(), lead: Promise.withResolvers() }
  const started = Promise.withResolvers()
  let count = 0
  const { execute, calls } = fixture({ reply(bot) { if (++count === 2) started.resolve(); return gates[bot].promise } })
  const replies = []
  const published = Promise.withResolvers()
  const run = execute({ ...input, text: '@Writer @Lead' }, { authorize: () => true, publish(reply) { replies.push(reply.by); published.resolve() } })
  await started.promise
  assert.deepEqual(calls.map(call => call.scope.botId), ['writer', 'lead'])
  gates.lead.resolve('completed')
  await published.promise
  gates.writer.resolve('completed')
  await run
  assert.deepEqual(replies, ['lead', 'writer'])
  assert.ok(calls.every(call => !call.text.includes('Earlier replies')))

  const all = fixture({ reply: bot => bot === 'lead' ? 'unknown' : undefined })
  await assert.rejects(all.execute({ ...input, text: '@all' }, { authorize: () => true, publish() {} }), { code: 'worker-outcome-unknown' })
  assert.deepEqual(all.calls.map(call => call.scope.botId), ['lead', 'writer'])
})

test('room HTTP rejects an active round and rechecks the admitted login before the remaining Bot', async t => {
  const gate = Promise.withResolvers()
  const started = Promise.withResolvers()
  const finished = Promise.withResolvers()
  const { execute, calls, readRoster } = fixture({ mode: 'everyone', reply() { started.resolve(); return gate.promise } })
  const dir = await mkdtemp(join(tmpdir(), 'room-dispatch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = await openEmployeeGroupStore(dir)
  const runtime = createEmployeeGroupRuntime({ store, openingRounds: true, async execute(message, controls) {
    try { await execute(message, controls) } finally { finished.resolve() }
  } })
  let active = true
  const handle = createEmployeeGroupChatHandler({ origin, readRoster, ...runtime, accounts: {
    resolveSession: () => ({ personId: 'alice', loginSessionId: 'fixture' }), isSessionActive: () => active,
  } })
  const api = createEmployeeApi({ fetch: (path, options) => handle(new Request(new URL(path, origin), {
    ...options, headers: { ...options.headers, Origin: origin, Cookie: '__Host-dsbot-employee=' + 'a'.repeat(43) },
  })) })
  const { requestId } = await api.sendGroup('general', 'First')
  await started.promise
  await assert.rejects(api.sendGroup('general', 'Too early'), { code: 'room-round-in-progress', status: 409 })
  active = false
  gate.resolve()
  await finished.promise
  assert.deepEqual(calls.map(call => call.scope.botId), ['lead'])
  assert.equal((await store.readTail('general')).filter(row => row.kind === 'user').length, 1)
  const row = { roomId: 'general', kind: 'bot', by: 'writer', name: 'Writer', text: 'second reply' }
  assert.deepEqual(await store.append('general', { requestId, replyId: 'writer', rows: [row] }), { appended: true })
  const reopened = await openEmployeeGroupStore(dir)
  assert.deepEqual(await reopened.append('general', { requestId, replyId: 'writer', rows: [row] }), { appended: false })
  assert.deepEqual((await reopened.readTail('general')).map(row => row.by), ['alice', 'lead', 'writer'])
})

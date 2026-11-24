import assert from 'node:assert/strict'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createEmployeeGroupChatHandler } from '../src/host/enterprise/group-chat-http.js'
import { createEmployeeGroupRuntime } from '../src/host/enterprise/group-runtime.js'

const origin = 'https://employee.example.test'
const identities = new Map([
  ['A'.repeat(43), { personId: 'alice', loginSessionId: 'login-a' }],
  ['B'.repeat(43), { personId: 'bob', loginSessionId: 'login-b' }],
])
const accounts = { resolveSession: token => identities.get(token), isSessionActive: () => true }

function request(handler, person, room, text) {
  const token = (person === 'alice' ? 'A' : 'B').repeat(43)
  const headers = { Cookie: '__Host-dsbot-employee=' + token }
  const path = origin + '/api/enterprise/group-chat/' + room + '/'
  return handler(text === undefined ? new Request(path + 'history', { headers }) : new Request(path + 'send', {
    method: 'POST', headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  }))
}

function fixtureStore(dir, didCommit = () => {}) {
  return {
    async readTail(roomId, { limit }) {
      try {
        return JSON.parse(await readFile(join(dir, roomId + '.json'), 'utf8')).slice(-limit)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        return []
      }
    },
    async append(roomId, { requestId, rows }) {
      const path = join(dir, roomId + '.json')
      const prior = await this.readTail(roomId, { limit: Number.MAX_SAFE_INTEGER })
      await writeFile(path + '.next', JSON.stringify([...prior, ...rows]))
      await rename(path + '.next', path)
      didCommit(requestId)
    },
  }
}

test('group runtime preserves room order and attribution, with live revocation before queued execution', { timeout: 5000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ds-bot-group-runtime-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const state = {
    people: { alice: { id: 'alice', name: 'Alice' }, bob: { id: 'bob', name: 'Bob' } },
    rooms: {
      general: { id: 'general', people: ['alice', 'bob'] },
      other: { id: 'other', people: ['alice'] },
    },
  }
  const hold = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const secondEntered = Promise.withResolvers()
  const secondRelease = Promise.withResolvers()
  const observed = []
  const commits = []
  const committed = Promise.withResolvers()
  const runtime = createEmployeeGroupRuntime({
    store: fixtureStore(dir, requestId => {
      commits.push(requestId)
      if (commits.length === 4) committed.resolve()
    }), maxActive: 2, maxPending: 3, maxPendingPerRoom: 2,
    async execute(input) {
      observed.push(input)
      if (input.text === 'first') {
        entered.resolve()
        await hold.promise
      }
      if (input.text === 'second') {
        secondEntered.resolve()
        await secondRelease.promise
      }
      return { roomId: input.roomId, text: 'reply to ' + input.text, by: 'helper', name: 'Helper' }
    },
  })
  const makeHandler = callbacks => createEmployeeGroupChatHandler({ origin, accounts, readRoster: () => state, ...callbacks })
  const handler = makeHandler(runtime)
  async function send(person, room, text) {
    const response = await request(handler, person, room, text)
    assert.equal(response.status, 202)
    return (await response.json()).requestId
  }
  const first = await send('alice', 'general', 'first')
  await entered.promise
  const second = await send('bob', 'general', 'second')
  const other = await send('alice', 'other', 'separate')
  assert.equal((await request(handler, 'bob', 'other')).status, 403)
  assert.deepEqual(observed.map(input => input.text), ['first', 'separate'])
  const dropped = await send('bob', 'general', 'will be denied')
  assert.equal((await request(handler, 'alice', 'general', 'overflow')).status, 503)
  hold.resolve()
  await secondEntered.promise
  const reopened = makeHandler(createEmployeeGroupRuntime({ store: fixtureStore(dir), execute: async () => undefined }))
  const revokeWhileReading = makeHandler({ ...runtime, async readHistory(input) {
    const snapshot = await runtime.readHistory(input)
    state.rooms.general.people = ['alice']
    return snapshot
  } })
  assert.equal((await request(revokeWhileReading, 'bob', 'general')).status, 403)
  const marker = await send('alice', 'general', 'last')
  secondRelease.resolve()
  await committed.promise
  assert.ok(commits.includes(other))
  assert.deepEqual(commits.filter(id => id !== other), [first, second, marker])
  assert.ok(!commits.includes(dropped))
  assert.deepEqual(observed.map(input => [input.roomId, input.source.by, input.source.name, input.text]), [
    ['general', 'alice', 'Alice', 'first'], ['other', 'alice', 'Alice', 'separate'],
    ['general', 'bob', 'Bob', 'second'], ['general', 'alice', 'Alice', 'last'],
  ])
  assert.equal((await request(reopened, 'bob', 'general')).status, 403)
  assert.equal((await request(reopened, 'bob', 'general', 'revoked')).status, 403)
  const saved = await (await request(reopened, 'alice', 'general')).json()
  assert.deepEqual(saved.messages.map(({ kind, by, text }) => [kind, by, text]), [
    ['user', 'alice', 'first'], ['bot', 'helper', 'reply to first'],
    ['user', 'bob', 'second'], ['bot', 'helper', 'reply to second'],
    ['user', 'alice', 'last'], ['bot', 'helper', 'reply to last'],
  ])
  const isolated = await (await request(reopened, 'alice', 'other')).json()
  assert.deepEqual(isolated.messages.map(row => row.text), ['separate', 'reply to separate'])
})

test('foreign or oversized storage results fail closed', async () => {
  const foreign = { roomId: 'other', kind: 'user', by: 'alice', name: 'Alice', text: 'other room text' }
  const runtime = createEmployeeGroupRuntime({ execute: async () => undefined, store: {
    async readTail(_room, { limit }) {
      assert.equal(limit, 100)
      return [foreign]
    },
    async append() { assert.fail('unexpected room write') },
  } })
  await assert.rejects(runtime.readHistory({ roomId: 'general', limit: 1000 }), /Invalid scoped room transcript/)
  const oversized = createEmployeeGroupRuntime({ execute: async () => undefined, store: {
    readTail: (_room, { limit }) => Array(limit + 1).fill({ ...foreign, roomId: 'general' }),
    append: async () => {},
  } })
  await assert.rejects(oversized.readHistory({ roomId: 'general', limit: 1000 }), /Invalid scoped room transcript/)
})

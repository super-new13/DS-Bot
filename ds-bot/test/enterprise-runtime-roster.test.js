import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canAccessEmployeeBot, canAccessEmployeeRoom } from '../src/host/enterprise/authorization.js'
import { createEnterpriseRuntimeRoster } from '../src/host/enterprise/runtime-roster.js'

const worker = () => ({ create() {}, submit() {}, cancel() {} })

function fixture() {
  const config = {
    people: {
      alice: { id: 'alice', name: 'Alice', color: 'blue', createdAt: 1000, botIds: ['assistant'] },
      bob: { id: 'bob', name: 'Bob', botIds: [] },
    },
    bots: {
      assistant: { id: 'assistant', nodeId: 'node-a', internal: 'host fixture' },
      private: { id: 'private', nodeId: 'node-a', private: true },
      offline: { id: 'offline', nodeId: 'node-offline' },
      unbound: { id: 'unbound' },
    },
    rooms: { general: { id: 'general', people: ['alice', 'bob'], members: ['assistant'] } },
  }
  const workers = new Map([['node-a', worker()], ['node-b', worker()]])
  const runtime = createEnterpriseRuntimeRoster({ readConfig: () => config, workers })
  return { config, workers, ...runtime }
}

test('fresh frozen snapshots work with existing authorization and observe employee revocation', () => {
  const { config, readRoster } = fixture()
  const first = readRoster()
  assert.equal(canAccessEmployeeBot(first, 'alice', 'assistant'), true)
  assert.equal(canAccessEmployeeRoom(first, 'alice', 'general'), true)
  assert.equal(canAccessEmployeeRoom(first, 'bob', 'general'), true)
  assert.equal(canAccessEmployeeBot(first, 'bob', 'assistant'), false)
  assert.equal(first.bots.assistant.internal, undefined)
  assert.throws(() => first.rooms.general.people.push('stranger'), TypeError)
  assert.throws(() => { first.people.alice.botIds = [] }, TypeError)
  assert.throws(() => { first.bots.assistant.nodeId = 'node-b' }, TypeError)
  config.people.alice.revokedAt = 0
  config.rooms.general.people = ['alice']
  const current = readRoster()
  assert.equal(current.people.alice.revokedAt, 0)
  assert.equal(canAccessEmployeeBot(current, 'alice', 'assistant'), false)
  assert.equal(canAccessEmployeeRoom(current, 'alice', 'general'), false)
  assert.equal(canAccessEmployeeRoom(current, 'bob', 'general'), false)
  assert.equal(canAccessEmployeeRoom(first, 'bob', 'general'), true)
})

test('per-Bot resolution uses the current registry and refuses private, unbound, and unregistered targets', () => {
  const { config, workers, resolveBot, readRoster } = fixture()
  const initial = resolveBot('assistant')
  assert.deepEqual(initial, { botId: 'assistant', nodeId: 'node-a', worker: workers.get('node-a') })
  assert.equal(initial.worker, resolveBot('assistant').worker)
  for (const id of ['private', 'offline', 'unbound', 'unknown', 'constructor']) assert.equal(resolveBot(id), undefined)
  assert.equal(canAccessEmployeeBot(readRoster(), 'alice', 'private'), false)

  config.bots.assistant.nodeId = 'node-b'
  assert.deepEqual(resolveBot('assistant'), { botId: 'assistant', nodeId: 'node-b', worker: workers.get('node-b') })
  const replacement = worker()
  workers.set('node-b', replacement)
  assert.equal(resolveBot('assistant').worker, replacement)
  workers.set('node-b', { create() {} })
  assert.equal(resolveBot('assistant'), undefined)
  workers.delete('node-b')
  assert.equal(resolveBot('assistant'), undefined)
})

test('invalid references and private grants fail closed without a stale roster fallback', () => {
  const invalid = [
    config => { config.people.alice.botIds = ['missing'] },
    config => { config.people.alice.botIds = ['private'] },
    config => { config.rooms.general.people = ['missing'] },
    config => { config.rooms.general.people = ['alice', 'alice'] },
    config => { config.rooms.general.members = ['missing'] },
    config => { config.rooms.general.members = ['private'] },
    config => { config.bots.assistant.nodeId = 'https://example.test' },
    config => { config.bots.assistant.id = 'different-id' },
    config => { config.people.alice.revokedAt = null },
    config => { config.people.bob.name = 'Alice' },
    config => { config.people.alice.botIds = Array(1) },
  ]
  for (const corrupt of invalid) {
    const { config, readRoster, resolveBot } = fixture()
    assert.ok(resolveBot('assistant'))
    corrupt(config)
    assert.throws(readRoster, /Invalid enterprise roster/)
    assert.throws(() => resolveBot('assistant'), /Invalid enterprise roster/)
  }
})

test('supports the design limits for people, names and group membership', () => {
  const { config, readRoster } = fixture()
  config.people = Object.fromEntries(Array.from({ length: 200 }, (_, index) => {
    const id = 'employee-' + index
    return [id, { id, name: id, botIds: [] }]
  }))
  config.people['employee-0'].name = '中'.repeat(40)
  config.rooms.general.people = Object.keys(config.people).slice(0, 100)
  assert.equal(Object.keys(readRoster().people).length, 200)
  config.rooms.general.people.push('employee-100')
  assert.throws(readRoster, /employee membership/)
  config.rooms.general.people.pop()
  config.people['employee-0'].name += '字'
  assert.throws(readRoster, /employee name/)
  config.people['employee-0'].name = 'Restored'
  config.people.extra = { id: 'extra', name: 'Extra', botIds: [] }
  assert.throws(readRoster, /Invalid enterprise roster people/)
})

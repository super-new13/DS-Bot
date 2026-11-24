import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canAccessEmployeeBot } from '../src/host/enterprise/authorization.js'
import { createDispatchQueue } from '../src/host/enterprise/dispatch-queue.js'
import { createEmployeeGroupAccess } from '../src/host/enterprise/group-access.js'

const alice = Object.freeze({ personId: 'alice', loginSessionId: 'login-a' })
const bob = Object.freeze({ personId: 'bob', loginSessionId: 'login-b' })
const outsider = Object.freeze({ personId: 'eve', loginSessionId: 'login-e' })
const payload = (requestId, roomId = 'general') => ({ roomId, requestId, text: 'Mock group message' })

function fixture(overrides = {}) {
  const state = {
    people: {
      alice: { id: 'alice', name: 'Alice', botIds: [] },
      bob: { id: 'bob', name: 'Bob', botIds: [] },
      eve: { id: 'eve', name: 'Eve', botIds: [] },
    },
    rooms: {
      general: { id: 'general', people: ['alice', 'bob'], members: ['bot'] },
      other: { id: 'other', people: ['alice', 'eve'], members: ['bot'] },
    },
    bots: { bot: { id: 'bot' } },
  }
  const sessions = new Map([alice, bob, outsider].map(identity => [identity.loginSessionId, identity.personId]))
  const scopes = new Map([
    ['group-session', { kind: 'room', roomId: 'general', sessionId: 'group-session' }],
    ['other-session', { kind: 'room', roomId: 'other', sessionId: 'other-session' }],
    ['private-session', { kind: 'private', personId: 'alice', botId: 'bot', sessionId: 'private-session' }],
    ['wrong-id', { kind: 'room', roomId: 'general', sessionId: 'group-session' }],
  ])
  const access = createEmployeeGroupAccess({
    readRoster: () => state,
    isSessionActive: identity => sessions.get(identity.loginSessionId) === identity.personId,
    resolveSession: sessionId => scopes.get(sessionId),
    ...overrides,
  })
  return { access, state, sessions }
}

test('two group members can read and submit, and a foreign employee cannot', async () => {
  const { state, access } = fixture()
  for (const identity of [alice, bob]) {
    assert.equal(await access.canReadRoom(identity, 'general'), true)
    assert.equal(canAccessEmployeeBot(state, identity.personId, 'bot'), false)
    assert.ok(await access.admitMessage(identity, payload(identity.personId)))
  }
  const group = { type: 'group', roomId: 'general' }
  assert.equal(await access.canReadEvent(alice, 'general', group), true)
  assert.equal(await access.canReadEvent(bob, 'general', group), true)
  assert.equal(await access.canReadEvent(outsider, 'general', group), false)
  assert.equal(await access.canReadRoom(outsider, 'general'), false)
  assert.equal(await access.admitMessage(outsider, payload('rejected')), undefined)
  assert.equal(await access.admitMessage({ personId: 'alice', loginSessionId: bob.loginSessionId }, payload('rejected')), undefined)
  assert.equal(await access.canReadRoom(alice, 'missing'), false)
  assert.equal(await access.canReadRoom(undefined, 'general'), false)
})

test('queued attribution is copied from trusted context and survives caller and roster mutations', async () => {
  const { state, access } = fixture()
  const context = { ...alice }
  const input = { ...payload('request-a'), by: 'bob', name: 'Fake', via: 'fake', source: { by: 'eve' }, identity: outsider }
  const admission = access.admitMessage(context, input)
  context.personId = 'bob'
  input.text = 'Changed after submission'
  const queued = await admission
  state.people.alice.name = 'Renamed'
  assert.deepEqual(queued, { ...payload('request-a'), source: { by: 'alice', name: 'Alice', via: 'DS Bot web' }, identity: alice })
  assert.ok(Object.isFrozen(queued) && Object.isFrozen(queued.source) && Object.isFrozen(queued.identity))
  assert.throws(() => { queued.source.by = 'bob' }, TypeError)
  assert.throws(() => { queued.identity.loginSessionId = bob.loginSessionId }, TypeError)
  assert.equal(await access.canExecuteMessage(queued, 'general'), true)
  assert.equal(await access.canExecuteMessage(queued, 'other'), false)
  assert.equal(await access.canExecuteMessage({ ...queued }, 'general'), false)
})

test('session events stay in the resolved room and cards go only to their original actor', async () => {
  const { access } = fixture()
  const event = { type: 'message', roomId: 'general', sessionId: 'group-session' }
  assert.equal(await access.canReadEvent(alice, 'general', event), true)
  assert.equal(await access.canReadEvent(bob, 'general', event), true)
  assert.equal(await access.canReadEvent(alice, 'other', event), false)
  for (const sessionId of ['other-session', 'private-session', 'wrong-id', 'missing', null]) {
    assert.equal(await access.canReadEvent(alice, 'general', { ...event, sessionId }), false)
  }
  assert.equal(await access.canReadEvent(alice, 'general', { ...event, type: 'unrecognized' }), false)

  const origin = await access.admitMessage(alice, payload('request-a'))
  for (const type of ['question', 'approval']) {
    const card = { ...event, type, requestId: 'request-a', origin }
    assert.equal(await access.canReadEvent(alice, 'general', card), true)
    assert.equal(await access.canReadEvent(bob, 'general', card), false)
    assert.equal(await access.canReadEvent(alice, 'general', { ...card, requestId: 'other-request' }), false)
    assert.equal(await access.canReadEvent(alice, 'general', { ...card, origin: undefined }), false)
    assert.equal(await access.canReadEvent(alice, 'general', { ...card, origin: { ...origin } }), false)
  }
})

test('removal blocks an existing subscription and queued execution without disrupting another member', async () => {
  const { access, state, sessions } = fixture()
  const first = await access.admitMessage(bob, payload('first'))
  const waiting = await access.admitMessage(alice, payload('waiting'))
  const later = await access.admitMessage(bob, payload('later'))
  const running = Promise.withResolvers()
  const release = Promise.withResolvers()
  const executed = []
  const queue = createDispatchQueue({
    maxActive: 1, maxPerBot: 1, maxPerNode: 1, maxPending: 2,
    authorize: request => access.canExecuteMessage(request.message, request.roomId),
    async execute({ message }) {
      executed.push(message.source.by + ':' + message.requestId)
      if (message === first) {
        running.resolve()
        await release.promise
      }
    },
  })
  const enqueue = message => queue.enqueue({
    message, requestId: message.requestId, roomId: message.roomId, sessionKey: message.roomId,
    personId: message.identity.personId, botId: 'bot', nodeId: 'node',
  })
  const firstResult = enqueue(first)
  await running.promise
  const waitingResult = assert.rejects(enqueue(waiting), { code: 'not-authorized' })
  const laterResult = enqueue(later)
  const event = { type: 'room', roomId: 'general' }
  assert.equal(await access.canReadEvent(alice, 'general', event), true)
  state.rooms.general.people = ['bob']
  release.resolve()
  await Promise.all([firstResult, waitingResult, laterResult])
  assert.deepEqual(executed, ['bob:first', 'bob:later'])
  assert.equal(await access.canReadRoom(alice, 'general'), false)
  assert.equal(await access.canReadEvent(alice, 'general', event), false)
  assert.equal(await access.canReadRoom(bob, 'general'), true)
  sessions.delete(bob.loginSessionId)
  assert.equal(await access.canReadEvent(bob, 'general', event), false)
  assert.equal(await access.canExecuteMessage(later, 'general'), false)
})

test('membership is checked after asynchronous login validation and lookup errors fail closed', async () => {
  const check = Promise.withResolvers()
  const { access, state } = fixture({ isSessionActive: () => check.promise })
  const read = access.canReadRoom(alice, 'general')
  const write = access.admitMessage(alice, payload('in-flight'))
  state.rooms.general.people = ['bob']
  check.resolve(true)
  assert.equal(await read, false)
  assert.equal(await write, undefined)
  const unavailable = fixture({ readRoster: () => { throw new Error('fixture unavailable') } }).access
  assert.equal(await unavailable.canReadRoom(alice, 'general'), false)
  assert.equal(await unavailable.admitMessage(alice, payload('rejected')), undefined)
})

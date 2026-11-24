import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { createEmployeeGroupChatHandler } from '../src/host/enterprise/group-chat-http.js'

const origin = 'https://employee.example.test'
const base = origin + '/api/enterprise/group-chat/'
const tokens = Object.fromEntries(['alice', 'bob', 'eve'].map(id => [id, randomBytes(32).toString('base64url')]))

function request(path, { person = 'alice', method = 'GET', body, headers = {}, url = base } = {}) {
  return new Request(url + path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(person ? { Cookie: '__Host-dsbot-employee=' + tokens[person] } : {}),
      ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
  })
}

const send = (person, body = { text: 'Hello' }) => request('general/send', { person, method: 'POST', body })

function fixture(overrides = {}) {
  const people = Object.fromEntries(Object.keys(tokens).map(id => [id, { id, name: id.toUpperCase(), botIds: [] }]))
  const roster = { people, rooms: { general: { id: 'general', people: ['alice', 'bob'] } } }
  const sessions = new Map(Object.entries(tokens).map(([personId, token]) => [token, { personId, loginSessionId: 'session-' + personId }]))
  const jobs = []
  const reads = []
  const handle = createEmployeeGroupChatHandler({
    origin,
    accounts: {
      resolveSession: token => sessions.get(token),
      isSessionActive: identity => sessions.get(tokens[identity.personId])?.loginSessionId === identity.loginSessionId,
    },
    readRoster: () => roster,
    readHistory: scope => {
      reads.push(scope)
      return { roomId: scope.roomId, messages: [
        { roomId: scope.roomId, kind: 'user', text: 'Previous message', by: 'alice', name: 'ALICE', internal: 'hidden' },
        { roomId: scope.roomId, kind: 'approval', text: 'Private card' },
      ] }
    },
    enqueue: (message, dispatch) => {
      jobs.push({ message, dispatch })
      return true
    },
    ...overrides,
  })
  return { handle, roster, jobs, reads, sessions }
}

test('two members read scoped history and send with independent server-derived attribution', async () => {
  const { handle, reads, roster, jobs } = fixture()
  const ids = []
  for (const person of ['alice', 'bob']) {
    const history = await handle(request('general/history', { person }))
    assert.equal(history.status, 200)
    assert.equal(history.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await history.json(), { roomId: 'general', messages: [{ kind: 'user', text: 'Previous message', by: 'alice', name: 'ALICE' }] })
    const queued = await handle(send(person))
    assert.equal(queued.status, 202)
    ids.push((await queued.json()).requestId)
  }
  assert.notEqual(ids[0], ids[1])
  assert.deepEqual(reads.map(read => [read.roomId, read.identity.personId]), [['general', 'alice'], ['general', 'bob']])
  assert.equal((await handle(send('bob', { text: 'Forged', by: 'alice' }))).status, 400)
  assert.equal(jobs.length, 2)
  roster.people.alice.name = 'Renamed'
  for (const [index, personId] of ['alice', 'bob'].entries()) {
    const { message, dispatch } = jobs[index]
    assert.equal(message.requestId, ids[index])
    assert.equal(message.roomId, 'general')
    assert.deepEqual(message.source, { by: personId, name: personId.toUpperCase(), via: 'DS Bot web' })
    assert.throws(() => { message.source.by = 'eve' }, TypeError)
    assert.throws(() => { message.identity.personId = 'eve' }, TypeError)
    assert.equal(await dispatch(executed => assert.equal(executed, message)), true)
    assert.equal(await dispatch(() => assert.fail('must execute once')), false)
  }
})

test('foreign and absent sessions cannot read or enqueue, including unknown rooms', async () => {
  const { handle, reads, jobs } = fixture()
  const foreignRead = await handle(request('general/history', { person: 'eve' }))
  const missingRead = await handle(request('missing/history'))
  assert.equal(foreignRead.status, 403)
  assert.equal(missingRead.status, 403)
  assert.deepEqual(await foreignRead.json(), await missingRead.json())
  assert.equal((await handle(send('eve'))).status, 403)
  assert.equal((await handle(request('general/history', { person: null }))).status, 401)
  assert.equal((await handle(request('general/history', { headers: { Cookie: '__Host-dsbot-employee=' + tokens.alice + '; __Host-dsbot-employee=' + tokens.bob } }))).status, 401)
  assert.deepEqual([reads.length, jobs.length], [0, 0])
})

test('room removal and login revocation drop accepted messages before dispatch', async () => {
  const { handle, roster, jobs, sessions } = fixture()
  for (const person of ['alice', 'bob', 'bob']) assert.equal((await handle(send(person))).status, 202)
  roster.rooms.general.people = ['bob']
  assert.equal(await jobs[0].dispatch(() => assert.fail('removed employee must not execute')), false)
  assert.equal((await handle(request('general/history'))).status, 403)
  assert.equal(await jobs[1].dispatch(message => assert.equal(message.source.by, 'bob')), true)
  sessions.delete(tokens.bob)
  assert.equal(await jobs[2].dispatch(() => assert.fail('revoked session must not execute')), false)
})

test('history is withheld after in-flight removal or on an inconsistent room result', async () => {
  const started = Promise.withResolvers()
  const done = Promise.withResolvers()
  const correct = { roomId: 'general', messages: [{ roomId: 'general', kind: 'user', text: 'Scoped text' }] }
  const { handle, roster } = fixture({ readHistory: () => { started.resolve(); return done.promise } })
  const pending = handle(request('general/history'))
  await started.promise
  roster.rooms.general.people = ['bob']
  done.resolve(correct)
  const response = await pending
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'Chat request refused' })
  const mixed = fixture({ readHistory: () => ({ ...correct, messages: [{ ...correct.messages[0], roomId: 'other' }] }) }).handle
  const mismatched = await mixed(request('general/history'))
  assert.equal(mismatched.status, 503)
  assert.deepEqual(await mismatched.json(), { error: 'Chat unavailable' })
})

test('strict methods, scoped paths, same-origin writes and body limits run before admission', async () => {
  const { handle, jobs } = fixture({ maxBodyBytes: 64 })
  const body = { text: 'Hello' }
  for (const headers of [{ Origin: 'https://wrong.example.test' }, { Origin: '' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    assert.equal((await handle(request('general/send', { method: 'POST', body, headers }))).status, 403)
  }
  assert.equal((await handle(request('general/send', { method: 'POST', body, url: 'https://wrong.example.test/api/enterprise/group-chat/' }))).status, 403)
  assert.equal((await handle(request('general/send'))).headers.get('allow'), 'POST')
  assert.equal((await handle(request('general/history', { method: 'POST', body }))).headers.get('allow'), 'GET')
  for (const path of ['general/history/', 'general%2Fother/history', 'general/unknown']) {
    assert.equal((await handle(request(path))).status, 404)
  }
  assert.equal((await handle(request('general/history?roomId=other'))).status, 400)
  assert.equal((await handle(request('general/send', { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } }))).status, 415)
  assert.equal((await handle(request('general/send', { method: 'POST', body, headers: { 'Content-Length': '65' } }))).status, 413)
  assert.equal((await handle(send('alice', { text: 'x'.repeat(65) }))).status, 413)
  assert.equal((await handle(send('alice', { text: '  ' }))).status, 400)
  assert.equal(jobs.length, 0)
})

test('queue rejection returns a generic error and invalidates the dispatch callback', async () => {
  let attempted
  const { handle } = fixture({ enqueue: (_, dispatch) => {
    attempted = dispatch(() => assert.fail('declined job must not execute'))
    return false
  } })
  const response = await handle(send('alice'))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'Chat unavailable' })
  assert.equal(await attempted, false)
})

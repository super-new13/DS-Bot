import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { registerEmployeeAdminRoute } from '../src/host/enterprise/admin-route.js'
import { createEmployeePrivateChatHandler } from '../src/host/enterprise/private-chat-http.js'
import { openEmployeeTranscriptStore } from '../src/host/enterprise/transcript-store.js'

const adminPath = '/api/bot/enterprise-admin'
const employeePath = '/api/enterprise/private-chat/'
const ownerOrigin = 'https://owner.invalid'
const employeeOrigin = 'https://employee.invalid'
const cookies = { alice: 'a'.repeat(43), bob: 'b'.repeat(43) }
const post = (url, origin, body, cookie) => new Request(url, { method: 'POST', body: JSON.stringify(body),
  headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie } })

async function fixture(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'dsbot-transcript-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = await openEmployeeTranscriptStore(dir, options)
  const accounts = {
    async issueInvite() {}, async revokeAccount() {},
    async resolveSession(token) {
      const personId = Object.keys(cookies).find(person => cookies[person] === token)
      return personId && { personId }
    },
    async isSessionActive(identity) { return roster.people[identity.personId]?.revokedAt === undefined },
  }
  const roster = { people: { alice: { id: 'alice', botIds: ['bot', 'other'] }, bob: { id: 'bob', botIds: ['bot'] } },
    bots: { bot: { id: 'bot' }, other: { id: 'other' } } }
  const pending = new Set()
  function track(promise) {
    pending.add(promise)
    void promise.then(() => pending.delete(promise), () => pending.delete(promise))
    return promise
  }
  async function drain() {
    while (pending.size > 0) {
      await Promise.allSettled(pending)
      await new Promise(resolve => setImmediate(resolve))
    }
  }
  const handle = createEmployeePrivateChatHandler({ origin: employeeOrigin, accounts, readRoster: () => roster,
    transcriptStore: { ...store, begin: input => track(store.begin(input)), finish: input => track(store.finish(input)), markIncomplete: input => track(store.markIncomplete(input)) },
    limits: { maxActive: 3, maxPerBot: 3, maxPerNode: 3, maxPending: 8 },
    resolveBot: botId => ({ botId, nodeId: 'mock-node', worker }),
  })
  const worker = {
    async create(scope) { return { ...scope, sessionId: scope.personId + '-' + scope.botId } },
    async submit({ sessionId, requestId, text }, event) {
      event({ requestId, sessionId: 'foreign', type: 'reply', text: 'foreign session' })
      event({ requestId: 'foreign', sessionId, type: 'reply', text: 'foreign request' })
      event({ requestId, sessionId, type: 'delta', text: 'streaming draft' })
      event({ requestId, sessionId, type: 'reply', text: 'Reply to ' + text })
      return { requestId, sessionId, status: 'completed' }
    },
  }
  const send = (personId, text, botId = 'bot', extra = {}) => handle(post(employeeOrigin + employeePath + 'send',
    employeeOrigin, { botId, text, ...extra }, '__Host-dsbot-employee=' + cookies[personId]))
  function routes(transcriptStore = store) {
    const registered = new Map()
    const ctx = { effect(install) { install() }, connection: { fetch: { register(route) { registered.set(route.path, route) } } } }
    registerEmployeeAdminRoute(ctx, { accounts, readRoster: () => roster, transcriptStore })
    async function call(request) {
      const headers = { 'Cache-Control': 'no-store' }
      if (request.headers.get('origin') !== ownerOrigin) return new Response(null, { status: 403, headers })
      if (request.headers.get('cookie') !== 'mock-owner=fixture') return new Response(null, { status: 401, headers })
      return registered.get(new URL(request.url).pathname).fetch(request)
    }
    return { read: (personId, botId, more = {}, opts = {}) => call(post(ownerOrigin + adminPath,
      opts.origin ?? ownerOrigin, { operation: 'transcript', personId, botId, ...more }, opts.cookie ?? 'mock-owner=fixture')),
    asset: (path, cookie = 'mock-owner=fixture') => call(new Request(ownerOrigin + adminPath + path,
      { headers: { Origin: ownerOrigin, Cookie: cookie } })) }
  }
  return { dir, routes, send, handle, roster, drain }
}

test('scoped conversations survive reopening and every bounded owner page has an audit', async t => {
  const { dir, routes, send, handle, roster, drain } = await fixture(t)
  const responses = await Promise.all([send('alice', 'First'), send('bob', 'Bob only'), send('alice', 'Other Bot', 'other')])
  for (const response of responses) assert.match(await response.text(), /"type":"done"/)
  assert.match(await (await send('alice', 'Second')).text(), /Reply to Second/)
  await drain()
  roster.people.alice.revokedAt = Date.now()
  const owner = routes(await openEmployeeTranscriptStore(dir))
  assert.equal((await owner.read('alice', 'bot', {}, { cookie: '__Host-dsbot-employee=' + cookies.bob })).status, 401)
  assert.equal((await owner.read('alice', 'bot', {}, { origin: employeeOrigin })).status, 403)
  assert.equal((await owner.read('alice', 'bot', { limit: 51 })).status, 400)
  assert.equal((await send('bob', 'spoof', 'bot', { personId: 'alice' })).status, 400)
  assert.equal((await handle(post(employeeOrigin + employeePath + 'history', employeeOrigin,
    { personId: 'alice', botId: 'bot' }, '__Host-dsbot-employee=' + cookies.bob))).status, 404)
  const response = await owner.read('alice', 'bot', { limit: 1 })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const latest = await response.json()
  assert.equal(latest.incomplete, false)
  assert.deepEqual(latest.turns.map(({ text, replies }) => [text, replies]), [['Second', ['Reply to Second']]])
  const older = await (await owner.read('alice', 'bot', { limit: 1, before: latest.nextBefore })).json()
  assert.equal(older.nextBefore, null)
  assert.deepEqual(older.turns.map(turn => turn.text), ['First'])
  const bob = await (await owner.read('bob', 'bot')).json()
  assert.deepEqual(bob.turns.map(turn => turn.text), ['Bob only'])
  const other = await (await owner.read('alice', 'other')).json()
  assert.deepEqual(other.turns.map(turn => turn.text), ['Other Bot'])
  const empty = await (await owner.read('bob', 'other')).json()
  assert.deepEqual(empty.turns, [])
  const files = (await readdir(dir)).filter(name => name.startsWith('owner-read-'))
  assert.equal(files.length, 5)
  const audit = await Promise.all(files.map(async file => JSON.parse(await readFile(join(dir, file), 'utf8'))))
  for (const page of [latest, older, bob, other, empty]) {
    const row = audit.find(row => row.ownerRequestId === page.ownerRequestId)
    assert.equal(row.owner, 'owner')
    assert.equal(row.personId, page.personId)
    assert.equal(row.botId, page.botId)
    assert.ok(row.at > 0)
    assert.equal(row.text, undefined)
  }
  const view = await owner.asset('/transcripts')
  assert.equal(view.headers.get('cache-control'), 'no-store')
  assert.match(await view.text(), /after recording was enabled/)
  assert.match(await (await owner.asset('/transcripts/page.js')).text(), /mountOwnerTranscript/)
  assert.equal((await owner.asset('/transcripts', '__Host-dsbot-employee=' + cookies.bob)).status, 401)
})

test('transcript failure preserves chat and marks the gap durably', async t => {
  const { dir, routes, send, drain } = await fixture(t, { maxBytes: 100 })
  const warned = Promise.withResolvers()
  const log = t.mock.method(console, 'warn', message => warned.resolve(message))
  const response = await send('alice', 'mock message')
  assert.match(await response.text(), /Reply to mock message/)
  assert.equal(await warned.promise, 'Could not record a private transcript turn')
  await drain()
  const reopened = await openEmployeeTranscriptStore(dir, { maxBytes: 100 })
  const page = await (await routes(reopened).read('alice', 'bot')).json()
  assert.equal(page.incomplete, true)
  assert.deepEqual(page.turns, [])
  assert.equal(log.mock.callCount(), 1)
})

test('owner cannot receive transcript data when durable audit commit fails', async t => {
  const { dir, routes } = await fixture(t)
  const target = join(dir, 'offline')
  await mkdir(target)
  const store = await openEmployeeTranscriptStore(target)
  await rm(target, { recursive: true })
  const response = await routes(store).read('alice', 'bot')
  assert.equal(response.status, 500)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), { error: 'Transcript could not be read' })
})

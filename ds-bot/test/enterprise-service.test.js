import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createEmployeeAccounts } from '../src/host/enterprise/accounts.js'
import { createEmployeeServiceHandler } from '../src/host/enterprise/enterprise-service.js'
import { startEnterpriseHttpsEntry } from '../src/host/enterprise/https-entry.js'

const host = '127.0.0.1'
const origin = 'https://' + host
const auth = '/api/enterprise/auth/'
const group = '/api/enterprise/group-chat/'
const privateSend = '/api/enterprise/private-chat/send'
const password = 'disposable enterprise fixture password'

async function fixture(t) {
  const state = { accounts: {}, sessions: [] }
  const accounts = createEmployeeAccounts({ read: () => state, transact: async change => change(state) })
  const roster = {
    people: { alice: { id: 'alice', name: 'Alice', botIds: ['helper'] } },
    bots: { helper: { id: 'helper' } },
    rooms: { 'demo_team': { id: 'demo_team', people: ['alice'] }, 'other-team': { id: 'other-team', people: [] } },
  }
  const dispatched = Promise.withResolvers()
  const trace = []
  const worker = {
    create(scope) { return { ...scope, sessionId: 'mock-worker-session' } },
    submit(input, emit) {
      trace.push('private:' + input.personId)
      const { sessionId, requestId } = input
      emit({ sessionId, requestId, type: 'reply', text: input.text })
      return { sessionId, requestId, status: 'completed' }
    },
  }
  const handler = createEmployeeServiceHandler({ origin, accounts, readRoster: () => roster,
    resolveBot: botId => ({ botId, nodeId: 'mock-node', worker }),
    limits: { maxActive: 2, maxPerBot: 2, maxPerNode: 2, maxPending: 2 },
    readHistory: ({ roomId, identity }) => {
      trace.push('history:' + identity.personId)
      return { roomId, messages: [{ roomId, kind: 'bot', text: 'group history', internal: 'fixture bookkeeping' }] }
    },
    enqueueGroup: (_, dispatch) => {
      void dispatch(dispatched.resolve).catch(dispatched.reject)
      return true
    },
  })
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-service-'))
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  let entry
  t.after(async () => {
    try { await entry?.close() } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:' + host,
    '-keyout', keyPath, '-out', certPath], { stdio: 'ignore', timeout: 5000 })
  const ca = readFileSync(certPath)
  entry = await startEnterpriseHttpsEntry({ origin, tls: { key: readFileSync(keyPath), cert: ca }, handler })

  async function send(path, { json, cookie, requestOrigin = origin } = {}) {
    const body = json === undefined ? undefined : JSON.stringify(json)
    const response = await new Promise((resolve, reject) => {
      const req = request({ host, port: entry.address.port, path, ca, agent: false,
        method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(4000),
        headers: { host, ...(cookie && { cookie }), ...(body !== undefined && {
          origin: requestOrigin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        }) },
      }, resolve)
      req.on('error', reject)
      req.end(body)
    })
    const text = (await Array.fromAsync(response.setEncoding('utf8'))).join('')
    return { status: response.statusCode, headers: response.headers, text }
  }

  async function login() {
    const invite = await accounts.issueInvite('alice')
    assert.equal((await send(auth + 'redeem', { json: { token: invite.token, password } })).status, 204)
    const response = await send(auth + 'login', { json: { personId: 'alice', password } })
    assert.equal(response.status, 204)
    return response.headers['set-cookie'][0].split(';', 1)[0]
  }
  return { send, login, trace, dispatched: dispatched.promise, handler }
}

test('one verified HTTPS listener serves scoped auth, private SSE and group history and send', { timeout: 10000 }, async t => {
  const { send, login, trace, dispatched } = await fixture(t)
  const cookie = await login()
  const session = await send(auth + 'session', { cookie })
  assert.equal(session.status, 200)
  assert.deepEqual(JSON.parse(session.text), { personId: 'alice' })

  const reply = await send(privateSend, { cookie, json: { botId: 'helper', text: 'private message' } })
  assert.equal(reply.status, 200)
  assert.match(reply.headers['content-type'], /^text\/event-stream/)
  const frames = reply.text.trim().split('\n\n').map(frame => JSON.parse(frame.slice(6)))
  assert.deepEqual(frames.map(frame => frame.type), ['queued', 'reply', 'done'])
  assert.equal(frames[1].text, 'private message')
  assert.equal(frames[2].status, 'completed')
  assert.ok(frames.every(frame => frame.requestId === frames[0].requestId))

  const history = await send(group + 'demo_team/history', { cookie })
  assert.equal(history.status, 200)
  assert.deepEqual(JSON.parse(history.text), { roomId: 'demo_team', messages: [{ kind: 'bot', text: 'group history' }] })
  assert.equal((await send(group + 'other-team/history', { cookie })).status, 403)
  assert.equal((await send(group + 'demo_team/history')).status, 401)
  assert.equal((await send(group + 'demo_team/send', { cookie, json: { text: 'wrong origin' }, requestOrigin: 'https://other.invalid' })).status, 403)
  const sent = await send(group + 'demo_team/send', { cookie, json: { text: 'group message' } })
  assert.equal(sent.status, 202)
  const message = await dispatched
  assert.equal(message.requestId, JSON.parse(sent.text).requestId)
  assert.equal(message.roomId, 'demo_team')
  assert.equal(message.text, 'group message')
  assert.deepEqual(message.source, { by: 'alice', name: 'Alice', via: 'DS Bot web' })
  assert.deepEqual(trace, ['private:alice', 'history:alice'])
})

test('both service and listener reject unrelated and noncanonical route paths', { timeout: 10000 }, async t => {
  const { send, handler, trace } = await fixture(t)
  for (const path of ['/', '/api/bot/hello', '/api/enterprise/auth/other', group + 'demo_team/events',
    group + 'demo_team/history/', group + 'two%2Frooms/history', group + 'a'.repeat(129) + '/history']) {
    assert.equal((await send(path)).status, 404)
    assert.equal((await handler(new Request(origin + path))).status, 404)
  }
  const wrongMethod = await send(group + 'demo_team/send')
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')
  assert.deepEqual(trace, [])
})

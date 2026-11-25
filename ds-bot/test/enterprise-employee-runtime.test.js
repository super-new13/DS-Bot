import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startEmployeeRuntime } from '../src/host/enterprise/employee-runtime.js'

const host = '127.0.0.1'
const origin = 'https://' + host
const auth = '/api/enterprise/auth/'
const privateSend = '/api/enterprise/private-chat/send'
const password = 'disposable runtime fixture password'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ds-bot-employee-runtime-'))
  const instances = []
  t.after(async () => {
    try {
      await Promise.all(instances.map(instance => instance.close()))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:' + host, '-keyout', keyPath, '-out', certPath], { stdio: 'ignore', timeout: 5000 })
  const cert = await readFile(certPath)
  const roster = {
    people: { alice: { id: 'alice', name: 'Alice', botIds: ['helper'] } },
    bots: { helper: { id: 'helper', nodeId: 'mock-node' } },
    rooms: { general: { id: 'general', people: ['alice'], members: ['helper'] } },
  }
  const submissions = []
  const workers = new Map([['mock-node', {
    create: scope => ({ ...scope, sessionId: 'mock-worker-session' }),
    submit(input, emit) {
      submissions.push(input)
      const { sessionId, requestId, text } = input
      emit({ sessionId, requestId, type: 'delta', text: 'Mock ' })
      emit({ sessionId, requestId, type: 'reply', text: 'Mock ' + text })
      return { sessionId, requestId, status: 'completed' }
    },
    cancel() { return { accepted: false } },
  }]])
  const options = {
    accountFile: join(dir, 'accounts.json'), readConfig: () => roster, workers,
    limits: { maxActive: 1, maxPerBot: 1, maxPerNode: 1, maxPending: 2 },
    readHistory: ({ roomId }) => ({ roomId, messages: [] }),
    enqueueGroup: () => false,
    https: { origin, tls: { key: await readFile(keyPath), cert } },
  }
  const start = async overrides => {
    const instance = await startEmployeeRuntime({ ...options, ...overrides })
    instances.push(instance)
    return instance
  }
  async function send(instance, path, { json, cookie, headers, method = json === undefined ? 'GET' : 'POST' } = {}) {
    const body = json === undefined ? undefined : JSON.stringify(json)
    const response = await new Promise((resolve, reject) => {
      const req = request({ host, port: instance.address.port, path, ca: cert, agent: false, method,
        signal: AbortSignal.timeout(4000), headers: { host, ...(cookie && { cookie }),
          ...(method === 'POST' && { origin }),
          ...(body !== undefined && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
          ...headers,
        },
      }, resolve)
      req.on('error', reject)
      req.end(body)
    })
    assert.equal(response.socket.authorized, true)
    const text = (await Array.fromAsync(response.setEncoding('utf8'))).join('')
    return { status: response.statusCode, headers: response.headers, text }
  }
  return { dir, options, submissions, start, send }
}

test('runtime serves HTTPS login and private SSE and restores the login after restart', { timeout: 10000 }, async t => {
  const { start, send, options, submissions } = await fixture(t)
  const runtime = await start({ initializeAccounts: true })
  const invite = await runtime.accounts.issueInvite('alice')
  assert.equal((await send(runtime, auth + 'redeem', { json: { token: invite.token, password } })).status, 204)
  const login = await send(runtime, auth + 'login', { json: { personId: 'alice', password } })
  assert.equal(login.status, 204)
  const rawCookie = login.headers['set-cookie'][0]
  assert.match(rawCookie, /; Secure; HttpOnly; SameSite=Strict$/)
  const cookie = rawCookie.split(';', 1)[0]
  const saved = await readFile(options.accountFile, 'utf8')
  for (const secret of [password, invite.token, cookie.split('=')[1]]) assert.equal(saved.includes(secret), false)

  const chat = await send(runtime, privateSend, { cookie, json: { botId: 'helper', text: 'reply' } })
  assert.equal(chat.status, 200)
  assert.match(chat.headers['content-type'], /^text\/event-stream/)
  const frames = chat.text.trim().split('\n\n').map(line => JSON.parse(line.slice('data: '.length)))
  assert.deepEqual(frames.map(frame => frame.type), ['queued', 'delta', 'reply', 'done'])
  assert.equal(frames[2].text, 'Mock reply')
  assert.equal(frames[3].status, 'completed')
  assert.ok(frames.every(frame => frame.requestId === frames[0].requestId))
  assert.equal(submissions[0].personId, 'alice')
  assert.equal(submissions[0].botId, 'helper')
  const history = await send(runtime, '/api/enterprise/group-chat/general/history', { cookie })
  assert.equal(history.status, 200)
  assert.deepEqual(JSON.parse(history.text), { roomId: 'general', messages: [] })

  const closing = runtime.close()
  assert.equal(runtime.close(), closing)
  await closing
  await assert.rejects(send(runtime, auth + 'session', { cookie }), { code: 'ECONNREFUSED' })
  const restarted = await start()
  const session = await send(restarted, auth + 'session', { cookie })
  assert.equal(session.status, 200)
  assert.deepEqual(JSON.parse(session.text), { personId: 'alice' })
  assert.equal((await send(restarted, auth + 'logout', { cookie, method: 'POST' })).status, 204)
  assert.equal((await send(restarted, auth + 'session', { cookie })).status, 401)
})

test('startup rejects missing or corrupt state, invalid roster, missing TLS and a busy port', { timeout: 10000 }, async t => {
  const { start, send, options } = await fixture(t)
  await assert.rejects(start(), { code: 'ENOENT' })
  await assert.rejects(start({ initializeAccounts: true, readConfig: () => ({}) }), /Invalid enterprise roster/)
  await assert.rejects(start({ initializeAccounts: true, https: { origin } }), /certificate and key material/)
  await assert.rejects(readFile(options.accountFile), { code: 'ENOENT' })

  const runtime = await start({ initializeAccounts: true })
  await assert.rejects(start({ accountFile: options.accountFile + '.other', initializeAccounts: true,
    https: { ...options.https, port: runtime.address.port } }), { code: 'EADDRINUSE' })
  assert.equal((await send(runtime, auth + 'session')).status, 401)
  await runtime.close()
  const corrupt = '{truncated'
  await writeFile(options.accountFile, corrupt)
  await assert.rejects(start({ initializeAccounts: true }), /Invalid employee account store/)
  assert.equal(await readFile(options.accountFile, 'utf8'), corrupt)
})

test('standalone owner uses a bearer and can read private chat from the shared store', { timeout: 10000 }, async t => {
  const { dir, start, send } = await fixture(t)
  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const transcriptDirectory = join(dir, 'private-transcripts')
  await mkdir(transcriptDirectory, { mode: 0o700 })
  const runtime = await start({ initializeAccounts: true, owner: { tokenHash, transcriptDirectory } })
  const ownerPath = '/api/enterprise/owner/'
  const headers = { authorization: 'Bearer ' + token }
  const person = { personId: 'alice' }
  const scope = { ...person, botId: 'helper' }
  const call = (operation, json, overrides) => send(runtime, ownerPath + operation, { json, headers, ...overrides })
  const page = await send(runtime, '/owner')
  assert.equal(page.status, 200)
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/)
  assert.match(page.text, /src="\/owner.js"/)
  assert.equal((await send(runtime, '/owner.js')).status, 200)
  assert.ok(!(await send(runtime, '/')).text.includes('href="/owner"'))
  const noOwner = await call('transcript', scope, { headers: {} })
  assert.equal(noOwner.status, 401)
  assert.equal(noOwner.headers['cache-control'], 'no-store')
  assert.equal((await call('invite', person, { headers: { ...headers, origin: 'https://foreign.invalid' } })).status, 403)
  assert.equal((await call('invite', undefined, { method: 'GET' })).status, 405)
  assert.equal((await call('unknown', person)).status, 404)
  const audit = await call('audit', { operation: 'audit', query: {} })
  assert.equal(audit.status, 503)
  assert.deepEqual(JSON.parse(audit.text), { error: 'Audit records unavailable' })
  const invitation = await call('invite', person)
  assert.equal(invitation.status, 201)
  assert.ok(!invitation.text.includes(token))
  assert.equal((await send(runtime, auth + 'redeem', { json: { token: JSON.parse(invitation.text).token, password } })).status, 204)
  const login = await send(runtime, auth + 'login', { json: { ...person, password } })
  assert.equal(login.status, 204)
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  assert.equal((await call('transcript', scope, { headers: {}, cookie })).status, 401)
  const chat = await send(runtime, privateSend, { cookie, json: { botId: scope.botId, text: 'fixture prompt' } })
  assert.equal(chat.status, 200)
  assert.match(chat.text, /Mock fixture prompt/)
  const result = await call('transcript', scope)
  assert.equal(result.status, 200)
  const transcript = JSON.parse(result.text)
  assert.equal(transcript.turns[0]?.text, 'fixture prompt')
  assert.ok((await readdir(transcriptDirectory)).some(name => name.startsWith('owner-read-')))
  assert.equal((await call('revoke', person)).status, 204)
  assert.equal((await send(runtime, auth + 'session', { cookie })).status, 401)
})

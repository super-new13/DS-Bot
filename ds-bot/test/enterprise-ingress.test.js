import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { createServer, request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { test } from 'node:test'
import { checkServerIdentity } from 'node:tls'
import { createEmployeeAccounts } from '../src/host/enterprise/accounts.js'
import { createEmployeePrivateChatHandler } from '../src/host/enterprise/private-chat-http.js'

const host = '127.0.0.1'
const auth = '/api/enterprise/auth/'
const chat = '/api/enterprise/private-chat/'
const routes = new Set([auth + 'redeem', auth + 'login', auth + 'logout', auth + 'session', chat + 'send', chat + 'cancel'])
const forwardedFields = ['content-type', 'content-length', 'content-encoding', 'origin', 'sec-fetch-site', 'cookie']
const password = 'disposable account fixture password'
const spoofed = {
  forwarded: 'for=192.0.2.10;host=elsewhere.invalid;proto=http',
  'x-forwarded-for': '192.0.2.10', 'x-forwarded-host': 'elsewhere.invalid',
  'x-forwarded-proto': 'http', 'x-employee-id': 'bob',
}

async function bridge(req, res, origin, handler, observe) {
  const path = req.url?.split('?', 1)[0]
  if (req.headers.host !== new URL(origin).host || !routes.has(path)) {
    res.writeHead(404).end()
    return
  }
  const headers = new Headers()
  for (const name of forwardedFields) {
    if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name])
  }
  const abort = new AbortController()
  res.once('close', () => { if (!res.writableFinished) abort.abort() })
  const hasBody = req.headers['transfer-encoding'] !== undefined || Number(headers.get('content-length')) > 0
  const input = new Request(origin + req.url, {
    method: req.method, headers, signal: abort.signal,
    ...(hasBody && { body: Readable.toWeb(req), duplex: 'half' }),
  })
  const context = { clientKey: req.socket.remoteAddress }
  observe(input, context)
  const output = await handler(input, context)
  for (const [name, value] of output.headers) {
    if (name !== 'set-cookie') res.setHeader(name, value)
  }
  const cookies = output.headers.getSetCookie()
  if (cookies.length) res.setHeader('Set-Cookie', cookies)
  res.statusCode = output.status
  if (output.body) {
    res.flushHeaders()
    await pipeline(Readable.fromWeb(output.body), res, { signal: abort.signal })
  } else res.end()
}

async function fixture(t) {
  const tlsDir = mkdtempSync(join(tmpdir(), 'dsbot-ingress-'))
  const keyPath = join(tlsDir, 'key.pem')
  const certPath = join(tlsDir, 'cert.pem')
  const gate = Promise.withResolvers()
  const sockets = new Set()
  const observations = []
  const submissions = []
  let server
  let closed
  function shutdown() {
    return closed ??= (async () => {
      gate.resolve()
      try {
        const closing = server?.listening && new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve())
        })
        for (const socket of sockets) socket.destroy()
        await closing
      } finally {
        rmSync(tlsDir, { recursive: true, force: true })
      }
    })()
  }
  t.after(shutdown)
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:' + host,
    '-keyout', keyPath, '-out', certPath], { stdio: 'ignore', timeout: 5000 })
  const ca = readFileSync(certPath)
  let mount
  server = createServer({ key: readFileSync(keyPath), cert: ca }, (req, res) => {
    void mount(req, res).catch(error => res.destroy(error))
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.listen(0, host)
  await once(server, 'listening')
  const origin = 'https://' + host + ':' + server.address().port
  const state = { accounts: {}, sessions: [] }
  const accounts = createEmployeeAccounts({ read: () => state, transact: async change => change(state) })
  const roster = {
    people: { alice: { id: 'alice', botIds: ['shared'] }, bob: { id: 'bob', botIds: ['other'] } },
    bots: { shared: { id: 'shared' }, other: { id: 'other' } },
  }
  const worker = {
    create(scope) { return { ...scope, sessionId: 'mock-session-' + scope.personId } },
    async submit(input, emit) {
      submissions.push(input)
      const { sessionId, requestId, text } = input
      emit({ sessionId, requestId, type: 'delta', text })
      await gate.promise
      emit({ sessionId, requestId, type: 'reply', text })
      return { sessionId, requestId, status: 'completed' }
    },
  }
  const handler = createEmployeePrivateChatHandler({ accounts, origin, readRoster: () => roster,
    resolveBot: botId => ({ botId, nodeId: 'mock-worker', worker }),
    limits: { maxActive: 2, maxPerBot: 2, maxPerNode: 2, maxPending: 2 }, maxBodyBytes: 128 })
  mount = (req, res) => bridge(req, res, origin, handler, (input, context) => observations.push({
    url: input.url, clientKey: context.clientKey, length: input.headers.get('content-length'),
    forwarded: Object.keys(spoofed).some(name => input.headers.has(name)),
  }))

  function send(path, { method = 'GET', json, headers } = {}) {
    const body = json === undefined ? '' : JSON.stringify(json)
    return new Promise((resolve, reject) => {
      // Verify TLS against loopback independently of the tested Host header.
      const req = request(origin + path, { method, ca, agent: false,
        checkServerIdentity: (_name, cert) => checkServerIdentity(host, cert), headers: {
        ...(method === 'POST' && { origin, 'sec-fetch-site': 'same-origin', 'content-length': Buffer.byteLength(body) }),
        ...(json !== undefined && { 'content-type': 'application/json' }), ...headers,
      }, signal: AbortSignal.timeout(5000) }, resolve)
      req.on('error', reject)
      req.end(body)
    })
  }
  async function login() {
    const invite = await accounts.issueInvite('alice')
    const redeem = await send(auth + 'redeem', { method: 'POST', json: { token: invite.token, password } })
    assert.equal(redeem.statusCode, 204)
    await bodyText(redeem)
    const response = await send(auth + 'login', { method: 'POST', json: { personId: 'alice', password } })
    assert.equal(response.statusCode, 204)
    await bodyText(response)
    const [cookie] = response.headers['set-cookie']
    for (const flag of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']) assert.ok(cookie.split('; ').includes(flag))
    return cookie.split(';', 1)[0]
  }
  return { origin, send, login, observations, submissions, gate, shutdown, server, tlsDir }
}

async function bodyText(response) {
  return (await Array.fromAsync(response.setEncoding('utf8'))).join('')
}

async function* frames(response) {
  let buffer = ''
  for await (const chunk of response.setEncoding('utf8')) {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end)
      assert.ok(frame.startsWith('data: '))
      yield JSON.parse(frame.slice(6))
      buffer = buffer.slice(end + 2)
    }
  }
  assert.equal(buffer, '')
}

test('streams scoped private chat from a certificate-verified same-origin HTTPS listener', { timeout: 10000 }, async t => {
  const ingress = await fixture(t)
  const cookie = await ingress.login()
  const json = { botId: 'shared', text: 'Mock reply with UTF-8: 你好' }
  const response = await ingress.send(chat + 'send', { method: 'POST', json, headers: { cookie, ...spoofed } })
  assert.equal(response.statusCode, 200)
  assert.match(response.headers['content-type'], /^text\/event-stream/)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(ingress.observations.at(-1), { url: ingress.origin + chat + 'send', clientKey: host,
    length: String(Buffer.byteLength(JSON.stringify(json))), forwarded: false })
  const stream = frames(response)
  const { value: queued } = await stream.next()
  assert.equal(queued.type, 'queued')
  const { value: delta } = await stream.next()
  assert.deepEqual(delta, { type: 'delta', requestId: queued.requestId, text: json.text })
  assert.equal(response.complete, false)
  assert.equal(ingress.submissions[0].personId, 'alice')
  ingress.gate.resolve()
  assert.deepEqual(await Array.fromAsync(stream), [
    { type: 'reply', requestId: queued.requestId, text: json.text },
    { type: 'done', requestId: queued.requestId, status: 'completed' },
  ])
})

test('rejects cross-origin and unscoped traffic, preserves body lengths, and tears down', { timeout: 10000 }, async t => {
  const ingress = await fixture(t)
  const cookie = await ingress.login()
  const json = { botId: 'shared', text: 'fixture' }
  async function status(path, options) {
    const response = await ingress.send(path, options)
    await bodyText(response)
    return response.statusCode
  }
  assert.equal(await status(chat + 'send', { method: 'POST', json, headers: { cookie, origin: 'https://elsewhere.invalid', ...spoofed } }), 403)
  assert.equal(await status(chat + 'send', { method: 'POST', json, headers: spoofed }), 401)
  assert.equal(await status(chat + 'send', { method: 'POST', json: { ...json, botId: 'other' }, headers: { cookie, ...spoofed } }), 403)
  const calls = ingress.observations.length
  assert.equal(await status('/api/bot/hello', { headers: { cookie } }), 404)
  assert.equal(await status(auth + 'session', { headers: { cookie, host: 'elsewhere.invalid', ...spoofed } }), 404)
  assert.equal(ingress.observations.length, calls)
  const large = { ...json, text: 'a'.repeat(128) }
  assert.equal(await status(chat + 'send', { method: 'POST', json: large, headers: { cookie } }), 413)
  assert.equal(ingress.observations.at(-1).length, String(Buffer.byteLength(JSON.stringify(large))))
  assert.deepEqual(ingress.submissions, [])
  assert.equal(await status(auth + 'logout', { method: 'POST', headers: { cookie } }), 204)
  assert.equal(ingress.observations.at(-1).length, '0')
  assert.equal(await status(auth + 'session', { headers: { cookie } }), 401)
  await ingress.shutdown()
  assert.equal(ingress.server.listening, false)
  assert.equal(existsSync(ingress.tlsDir), false)
})

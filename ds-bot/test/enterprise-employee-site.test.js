import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startEmployeeRuntime } from '../src/host/enterprise/employee-runtime.js'

const host = '127.0.0.1'
const origin = 'https://' + host
const auth = '/api/enterprise/auth/'
const send = '/api/enterprise/private-chat/send'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ds-bot-employee-site-'))
  let runtime
  t.after(async () => {
    try { await runtime?.close() } finally { await rm(dir, { recursive: true, force: true }) }
  })
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:' + host, '-keyout', keyPath, '-out', certPath], { stdio: 'ignore', timeout: 5000 })
  const cert = await readFile(certPath)
  const submissions = []
  runtime = await startEmployeeRuntime({
    accountFile: join(dir, 'accounts.json'), initializeAccounts: true,
    https: { origin, tls: { key: await readFile(keyPath), cert } },
    readConfig: () => ({ people: { employee: { id: 'employee', name: 'Employee', botIds: ['helper'] } },
      bots: { helper: { id: 'helper', nodeId: 'mock' } }, rooms: {} }),
    workers: new Map([['mock', {
      create: scope => ({ ...scope, sessionId: 'scoped-session' }),
      submit(input, emit) {
        submissions.push(input)
        const { sessionId, requestId, text } = input
        emit({ sessionId, requestId, type: 'reply', text: 'Mock: ' + text })
        return { sessionId, requestId, status: 'completed' }
      },
      cancel: () => ({ accepted: false }),
    }]]),
    limits: { maxActive: 1, maxPerBot: 1, maxPerNode: 1, maxPending: 2 },
    readHistory: () => [], enqueueGroup: () => false,
  })
  async function call(path, { json, method = json === undefined ? 'GET' : 'POST', headers } = {}) {
    const body = json === undefined ? undefined : JSON.stringify(json)
    const res = await new Promise((resolve, reject) => {
      const req = request({ host, port: runtime.address.port, path, ca: cert, servername: "localhost", agent: false, method,
        signal: AbortSignal.timeout(4000), headers: { host, ...(method === 'POST' && { origin }),
          ...(body !== undefined && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
          ...headers },
      }, resolve)
      req.on('error', reject)
      req.end(body)
    })
    assert.equal(res.socket.authorized, true)
    const text = (await Array.fromAsync(res.setEncoding('utf8'))).join('')
    return { status: res.statusCode, headers: res.headers, text }
  }
  return { call, accounts: runtime.accounts, submissions }
}

const assets = [
  ['/', 'index.html', 'text/html'],
  ['/page.css', 'page.css', 'text/css'],
  ['/page.js', 'page.js', 'text/javascript'],
  ['/api.js', 'api.js', 'text/javascript'],
]

test('employee HTTPS serves exactly the four pilot assets on GET and HEAD', { timeout: 10000 }, async t => {
  const { call } = await fixture(t)
  for (const [path, file, mime] of assets) {
    const expected = await readFile(new URL('../src/client/enterprise/' + file, import.meta.url), 'utf8')
    const get = await call(path)
    const head = await call(path, { method: 'HEAD' })
    assert.equal(get.text, expected)
    assert.equal(head.text, '')
    for (const { status, headers } of [get, head]) {
      assert.equal(status, 200)
      assert.equal(headers['content-type'], mime + '; charset=utf-8')
      assert.equal(Number(headers['content-length']), Buffer.byteLength(expected))
      assert.equal(headers['x-content-type-options'], 'nosniff')
      assert.equal(headers['cross-origin-resource-policy'], 'same-origin')
      assert.equal(headers['cache-control'], 'no-store')
      assert.equal(headers['referrer-policy'], 'no-referrer')
      assert.equal(headers['set-cookie'], undefined)
      const directives = headers['content-security-policy'].split('; ').sort()
      assert.deepEqual(directives, ["base-uri 'none'", "connect-src 'self'", "default-src 'none'", "form-action 'none'",
        "frame-ancestors 'none'", "script-src 'self'", "style-src 'self'"])
    }
    const post = await call(path, { method: 'POST' })
    assert.equal(post.status, 405)
    assert.equal(post.headers.allow, 'GET, HEAD')
    assert.equal((await call(path, { headers: { host: 'other.invalid' } })).status, 404)
  }
  for (const path of ['/index.html', '/page.js?x=1', '/page.js/', '/Page.js', '/%70age.js', '/other/../page.js',
    '//page.js', '/client.js', '/api/enterprise/unknown', '/api/bot', origin + '/page.js']) {
    assert.equal((await call(path)).status, 404, path)
  }
  assert.equal((await call('/', { method: 'GET', json: { unexpected: true } })).status, 400)
})

test('the same HTTPS origin serves the pilot and preserves private chat authorization', { timeout: 10000 }, async t => {
  const { call, accounts, submissions } = await fixture(t)
  assert.match((await call('/')).text, /src="\.\/page\.js"/)
  assert.match((await call('/page.js')).text, /from '\.\/api\.js'/)
  const password = 'disposable pilot fixture password'
  const { token } = await accounts.issueInvite('employee')
  assert.equal((await call(auth + 'redeem', { json: { token, password } })).status, 204)
  const login = await call(auth + 'login', { json: { personId: 'employee', password } })
  assert.equal(login.status, 204)
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  assert.equal((await call(auth + 'session', { method: 'HEAD', headers: { cookie } })).status, 405)
  assert.equal((await call(auth + 'session', { headers: { cookie } })).status, 200)
  const json = { botId: 'helper', text: 'pilot' }
  assert.equal((await call(send, { json })).status, 401)
  assert.equal((await call(send, { json, headers: { cookie, origin: 'https://other.invalid' } })).status, 403)
  assert.equal((await call(send, { json, headers: { cookie, host: 'other.invalid' } })).status, 404)
  assert.equal(submissions.length, 0)
  const chat = await call(send, { json, headers: { cookie } })
  assert.equal(chat.status, 200)
  assert.match(chat.headers['content-type'], /^text\/event-stream/)
  const frames = chat.text.trim().split('\n\n').map(frame => JSON.parse(frame.slice('data: '.length)))
  assert.deepEqual(frames.map(frame => frame.type), ['queued', 'reply', 'done'])
  assert.equal(frames[1].text, 'Mock: pilot')
  assert.equal(frames[2].status, 'completed')
  assert.equal(submissions.length, 1)
  assert.equal(submissions[0].personId, 'employee')
})

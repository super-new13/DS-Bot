import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createWorkerClient } from '../src/host/enterprise/worker-client.js'
import { createWorkerHttpHandler } from '../src/host/enterprise/worker-http.js'
import { openWorkerReceipts } from '../src/host/enterprise/worker-receipts.js'
import { createWorkerTlsTransport, startLocalWorkerTls } from '../src/host/enterprise/worker-tls.js'

const scope = { nodeId: 'worker', botId: 'bot', personId: 'alice', sessionId: 'mock-session' }
const root = '/internal/enterprise/worker/'
let certs

before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-worker-tls-'))
  after(() => rmSync(dir, { recursive: true, force: true }))
  const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, timeout: 5000, stdio: 'ignore' })
  openssl('req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '1', '-subj', '/CN=Worker fixture CA',
    '-keyout', 'ca.key', '-out', 'ca.pem')
  const ca = readFileSync(join(dir, 'ca.pem'))
  function sign(name, usage, san) {
    openssl('req', '-new', '-nodes', '-newkey', 'rsa:2048', '-subj', '/CN=' + name,
      '-keyout', name + '.key', '-out', name + '.csr')
    const extensions = ['basicConstraints=CA:FALSE', 'keyUsage=digitalSignature,keyEncipherment', 'extendedKeyUsage=' + usage]
    if (san) extensions.push('subjectAltName=' + san)
    writeFileSync(join(dir, name + '.ext'), extensions.join(String.fromCharCode(10)))
    openssl('x509', '-req', '-in', name + '.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-days', '1', '-extfile', name + '.ext', '-out', name + '.pem')
    return { ca, cert: readFileSync(join(dir, name + '.pem')), key: readFileSync(join(dir, name + '.key')) }
  }
  certs = {
    server: sign('server', 'serverAuth', 'IP:127.0.0.1'),
    wrongHost: sign('wrong-host', 'serverAuth', 'DNS:worker.example.test'),
    controller: sign('controller', 'clientAuth'),
    stranger: sign('stranger', 'clientAuth'),
  }
})

function post(origin, action, body = scope) {
  return new Request(origin + root + action, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

function raw(origin, path, tls, forgedFingerprint) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(origin + path, { ...tls, method: 'POST', agent: false, rejectUnauthorized: true,
      headers: { 'X-Peer-Fingerprint': forgedFingerprint ?? 'forged' }, signal: AbortSignal.timeout(2000),
    }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.end()
  })
}

test('mutual TLS connects the worker client and grants the verified controller only', { timeout: 5000 }, async t => {
  const expected = new X509Certificate(certs.controller.cert).fingerprint256
  const held = Promise.withResolvers()
  let invocations = 0
  let handler
  const entry = await startLocalWorkerTls({ ...certs.server, handler: (...args) => handler(...args) })
  t.after(async () => { held.resolve('completed'); await entry.close() })
  let saved = { version: 1, generation: null, receipts: {} }
  const receipts = await openWorkerReceipts({ read: () => structuredClone(saved), transact(change) {
    const next = structuredClone(saved)
    const result = change(next)
    saved = next
    return result
  } })
  handler = createWorkerHttpHandler({ nodeId: scope.nodeId, origin: entry.origin, receipts,
    authenticatePeer: peer => peer.fingerprint === expected ? 'controller' : undefined,
    authorizePeer: (peer, request) => peer === 'controller' && request.scope.personId === scope.personId,
    worker: {
      create: async input => ({ ...input, sessionId: scope.sessionId }),
      async submit(input, onEvent) {
        invocations += 1
        const { sessionId, requestId } = input
        onEvent({ type: 'delta', text: 'mock model', sessionId, requestId })
        return { status: await held.promise, sessionId, requestId }
      },
      cancel() { held.resolve('aborted'); return { accepted: true } },
    },
  })
  const transport = createWorkerTlsTransport({ ...certs.controller, origin: entry.origin })
  const client = createWorkerClient({ origin: entry.origin, nodeId: scope.nodeId, transport })
  assert.deepEqual(await client.create(scope), { sessionId: scope.sessionId })
  const first = Promise.withResolvers()
  const pending = client.submit(scope, 'operation', 'mock prompt', { onEvent: first.resolve })
  assert.deepEqual(await first.promise, { type: 'delta', text: 'mock model', requestId: 'operation' })
  assert.equal((await client.status(scope, 'operation')).status, 'admitted')
  assert.deepEqual(await client.cancel(scope, 'operation'), { accepted: true })
  assert.equal((await pending).status, 'aborted')
  assert.equal((await client.status(scope, 'operation')).status, 'aborted')
  assert.equal(invocations, 1)

  await assert.rejects(raw(entry.origin, root + 'status', { ca: certs.controller.ca }), /certificate|socket hang up/i)
  assert.equal(await raw(entry.origin, root + 'status', certs.stranger, expected), 403)
  assert.equal(await raw(entry.origin, '/other', certs.controller), 404)
  await assert.rejects(transport(post(entry.origin, 'other')), { code: 'worker-route-refused' })
})

test('transport rejects the wrong server hostname and does not follow redirects', { timeout: 5000 }, async t => {
  const wrong = await startLocalWorkerTls({ ...certs.wrongHost, handler: () => { throw new Error('unexpected dispatch') } })
  t.after(wrong.close)
  const wrongTransport = createWorkerTlsTransport({ ...certs.controller, origin: wrong.origin })
  await assert.rejects(wrongTransport(post(wrong.origin, 'status')), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
  let calls = 0
  const redirects = await startLocalWorkerTls({ ...certs.server, handler(request) {
    calls += 1
    return new Response(null, { status: 307, headers: { Location: new URL(root + 'cancel', request.url).href } })
  } })
  t.after(redirects.close)
  const transport = createWorkerTlsTransport({ ...certs.controller, origin: redirects.origin })
  await assert.rejects(transport(post(redirects.origin, 'status')), { code: 'worker-redirect-refused' })
  assert.equal(calls, 1)
})

test('transport deadlines cover stalled response headers and response body', { timeout: 5000 }, async t => {
  const aborted = Promise.withResolvers()
  const entry = await startLocalWorkerTls({ ...certs.server, timeoutMs: 250,
    handler(request) {
      return new Promise(resolve => request.signal.addEventListener('abort', () => {
        aborted.resolve()
        resolve(new Response())
      }, { once: true }))
    },
  })
  t.after(entry.close)
  const transport = createWorkerTlsTransport({ ...certs.controller, origin: entry.origin, timeoutMs: 1000 })
  await assert.rejects(transport(post(entry.origin, 'status')), { code: 'ECONNRESET' })
  await aborted.promise
  const slow = await startLocalWorkerTls({ ...certs.server, handler: () => new Response(new ReadableStream()) })
  t.after(slow.close)
  const fast = createWorkerTlsTransport({ ...certs.controller, origin: slow.origin, timeoutMs: 250 })
  const response = await fast(post(slow.origin, 'status'))
  await assert.rejects(response.text(), /abort/i)
})

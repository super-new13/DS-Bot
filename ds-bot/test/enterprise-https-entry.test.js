import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkServerIdentity } from 'node:tls'
import { startEnterpriseHttpsEntry } from '../src/host/enterprise/https-entry.js'

const host = '127.0.0.1'
const origin = 'https://' + host
const sendPath = '/api/enterprise/private-chat/send'
const sessionPath = '/api/enterprise/auth/session'
const logoutPath = '/api/enterprise/auth/logout'

async function fixture(t, handler, options) {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-https-entry-'))
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')
  let entry
  t.after(async () => {
    try { await entry?.close() } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:' + host,
    '-keyout', keyPath, '-out', certPath], { stdio: 'ignore', timeout: 5000 })
  const ca = readFileSync(certPath)
  entry = await startEnterpriseHttpsEntry({ tls: { key: readFileSync(keyPath), cert: ca }, origin, handler, ...options })
  function send(path, { method = 'GET', headers, write = req => req.end() } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({ host, port: entry.address.port, path, method, ca, agent: false,
        checkServerIdentity: (_name, cert) => checkServerIdentity(host, cert),
        headers: { host, ...headers }, signal: AbortSignal.timeout(4000) }, resolve)
      req.on('error', reject)
      write(req)
    })
  }
  return { send, close: entry.close }
}

async function bodyText(res) {
  return (await Array.fromAsync(res.setEncoding('utf8'))).join('')
}

const bounds = { timeout: 10000 }

test('uses canonical origin and the TLS peer, with exact host, route and method', bounds, async t => {
  const observed = []
  const { send } = await fixture(t, async (req, context) => {
    observed.push({ url: req.url, peer: context.clientKey, headers: Object.fromEntries(req.headers),
      body: req.body ? await req.text() : null })
    return new Response(null, { status: 204 })
  })
  const message = 'mock 你好'
  const reply = await send(sendPath, { method: 'POST', headers: {
    origin, 'content-length': Buffer.byteLength(message), 'content-type': 'text/plain',
    forwarded: 'for=192.0.2.1', 'x-forwarded-host': 'wrong.invalid', 'x-forwarded-for': '192.0.2.1',
    'x-forwarded-proto': 'http', 'x-employee-id': 'spoof',
  }, write: req => req.end(message) })
  assert.equal(reply.statusCode, 204)
  assert.deepEqual(observed, [{ url: origin + sendPath, peer: host, body: message,
    headers: { origin, 'content-length': String(Buffer.byteLength(message)), 'content-type': 'text/plain' } }])
  assert.equal((await send(sessionPath, { headers: { host: 'wrong.invalid' } })).statusCode, 404)
  assert.equal((await send('/api/bot/hello')).statusCode, 404)
  assert.equal((await send(sendPath)).statusCode, 405)
  assert.equal(observed.length, 1)
  assert.equal((await send(logoutPath, { method: 'POST', headers: { 'content-length': '0' } })).statusCode, 204)
  assert.equal(observed.at(-1).headers['content-length'], '0')
  assert.equal(observed.at(-1).body, null)
})

test('bounds declared and chunked bodies and rejects stalled uploads', bounds, async t => {
  let calls = 0
  const { send } = await fixture(t, () => {
    calls++
    return new Response(null, { status: 204 })
  }, { maxBodyBytes: 8, bodyTimeoutMs: 150 })
  const declared = await send(sendPath, { method: 'POST', headers: { 'content-length': '9' }, write: req => req.end('123456789') })
  const chunked = await send(sendPath, { method: 'POST', write: req => { req.write('12345'); req.end('6789') } })
  const stalled = await send(sendPath, { method: 'POST', headers: { 'content-length': '8' }, write: req => req.write('a') })
  assert.deepEqual([declared.statusCode, chunked.statusCode, stalled.statusCode], [413, 413, 408])
  await Promise.all([declared, chunked, stalled].map(bodyText))
  assert.equal(calls, 0)
})

test('streams without buffering to completion and closes an in-flight connection', bounds, async t => {
  const encoder = new TextEncoder()
  const streaming = Promise.withResolvers()
  const aborted = Promise.withResolvers()
  const cancelled = Promise.withResolvers()
  const { send, close } = await fixture(t, req => {
    req.signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: first\n\n'))
        streaming.resolve(controller)
      },
      cancel() { cancelled.resolve() },
    }), { headers: { 'content-type': 'text/event-stream' } })
  })
  const response = await send(sendPath, { method: 'POST', headers: { 'content-length': '0' } })
  const stream = response.setEncoding('utf8')[Symbol.asyncIterator]()
  const controller = await streaming.promise
  let text = ''
  while (text.length < 'data: first\n\n'.length) {
    const frame = await stream.next()
    assert.equal(frame.done, false)
    text += frame.value
  }
  assert.equal(text, 'data: first\n\n')
  assert.equal(response.complete, false)
  controller.enqueue(encoder.encode('data: second\n\n'))
  const closed = close()
  assert.equal(close(), closed)
  await Promise.all([closed, aborted.promise, cancelled.promise])
  await assert.rejects(send(sessionPath), { code: 'ECONNREFUSED' })
})

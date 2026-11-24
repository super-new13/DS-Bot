import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, watch, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { startEmployeeDeployment } from '../src/host/enterprise/employee-bootstrap.js'
import { createWorkerClient } from '../src/host/enterprise/worker-client.js'
import { createWorkerBootstrap } from '../src/host/enterprise/worker-bootstrap.js'
import { createWorkerTlsTransport } from '../src/host/enterprise/worker-tls.js'

function makeTls(dir) {
  const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, timeout: 5000, stdio: 'ignore' })
  openssl('req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '1', '-subj', '/CN=Runtime fixture CA',
    '-keyout', 'ca.key', '-out', 'ca.pem')
  const ca = readFileSync(join(dir, 'ca.pem'))
  function issue(name, extensions) {
    openssl('req', '-new', '-nodes', '-newkey', 'rsa:2048', '-subj', '/CN=' + name,
      '-keyout', name + '.key', '-out', name + '.csr')
    writeFileSync(join(dir, name + '.ext'), extensions.join(String.fromCharCode(10)))
    openssl('x509', '-req', '-in', name + '.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-days', '1', '-extfile', name + '.ext', '-out', name + '.pem')
    return { ca, key: readFileSync(join(dir, name + '.key')), cert: readFileSync(join(dir, name + '.pem')) }
  }
  return { server: issue('server', ['extendedKeyUsage=serverAuth', 'subjectAltName=IP:127.0.0.1']),
    controller: issue('controller', ['extendedKeyUsage=clientAuth']) }
}

class MockModel extends LlmAdapter {
  providerInfo() { return { id: 'mock', name: 'Mock' } }
  async resolveModel(provider, id) {
    if (id !== 'model') throw new Error('Unavailable fixture model')
    return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 }, defaultMaxTokens: 1000 }
  }
  calls = []
  async *stream({ messages, sessionId }) {
    this.calls.push({ sessionId, text: messages.filter(message => message.role !== 'system').flatMap(message =>
      message.content.flatMap(block => block.type === 'text' ? [block.text] : [])) })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'mock reply' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'mock reply' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}


const host = '127.0.0.1'
const origin = 'https://' + host
const auth = '/api/enterprise/auth/'
const chat = '/api/enterprise/group-chat/general/'
const nodeId = 'mock-node'
const botId = 'helper'

function call(runtime, ca, path, { cookie, json } = {}) {
  const body = json === undefined ? undefined : JSON.stringify(json)
  return new Promise((resolve, reject) => {
    const req = request({ host, port: runtime.address.port, path, ca, agent: false,
      method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(4000),
      headers: { host, ...(cookie && { cookie }), ...(body !== undefined && {
        origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      }) },
    }, async res => {
      try {
        assert.equal(res.socket.authorized, true)
        const text = (await Array.fromAsync(res.setEncoding('utf8'))).join('')
        resolve({ status: res.statusCode, headers: res.headers, text })
      } catch (error) { reject(error) }
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('room pilot keeps actor-scoped worker receipts and restores shared room history over TLS', { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-room-pilot-'))
  const disposers = []
  t.after(async () => {
    try { await Promise.all(disposers.map(dispose => dispose())) }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
  const tls = makeTls(dir)
  const file = name => join(dir, name)
  const fingerprint = new X509Certificate(tls.controller.cert).fingerprint256
  const people = Object.fromEntries([['alice', 'Alice'], ['bob', 'Bob'], ['outsider', 'Outsider']]
    .map(([id, name]) => [id, { id, name, botIds: [] }]))
  const roster = { people, bots: { helper: { id: botId, nodeId } },
    rooms: { general: { id: 'general', people: ['alice', 'bob'], members: [botId] } },
  }
  const directory = file('rooms')
  await mkdir(directory, { mode: 0o700 })
  const configFile = file('employee.json')
  async function start(initialize) {
    const profile = new Context()
    disposers.push(() => profile.fiber.dispose())
    const adapter = new MockModel()
    const ready = Promise.withResolvers()
    await profile.plugin(createWorkerBootstrap({ adapter, onReady: ready.resolve, config: {
      nodeId, provider: 'mock', model: 'model', initialize,
      receiptPath: file('receipts.json'), mappingPath: file('mapping.json'), sessionRoot: file('sessions'),
      certPaths: { ca: file('ca.pem'), cert: file('server.pem'), key: file('server.key') },
      peerGrants: ['alice', 'bob'].map(personId => ({ fingerprint, personId, botId, roomId: 'general', actions: ['create', 'submit', 'status'] })),
    } }))
    const { origin: workerOrigin } = await ready.promise
    await writeFile(configFile, JSON.stringify({
      accountFile: file('accounts.json'), initializeAccounts: initialize, roster,
      https: { origin, host, port: 0, certFile: file('server.pem'), keyFile: file('server.key') },
      workers: [{ nodeId, origin: workerOrigin, caFile: file('ca.pem'), certFile: file('controller.pem'), keyFile: file('controller.key') }],
      limits: { maxActive: 2, maxPerBot: 2, maxPerNode: 2, maxPending: 2 },
      groups: { directory, roomBots: { general: botId } },
    }))
    const employee = await startEmployeeDeployment(configFile)
    disposers.push(employee.close)
    const worker = createWorkerClient({ origin: workerOrigin, nodeId, transport: createWorkerTlsTransport({ ...tls.controller, origin: workerOrigin }) })
    return { employee, worker, adapter, close: async () => { await employee.close(); await profile.fiber.dispose() } }
  }
  const first = await start(true)
  const send = (runtime, path, options) => call(runtime.employee, tls.server.ca, path, options)
  async function login(personId) {
    const { token } = await first.employee.accounts.issueInvite(personId)
    const password = 'temporary room fixture password'
    assert.equal((await send(first, auth + 'redeem', { json: { token, password } })).status, 204)
    const response = await send(first, auth + 'login', { json: { personId, password } })
    assert.equal(response.status, 204)
    return response.headers['set-cookie'][0].split(';', 1)[0]
  }
  async function history(runtime, cookie) {
    const response = await send(runtime, chat + 'history', { cookie })
    assert.equal(response.status, 200)
    return JSON.parse(response.text).messages
  }
  async function turn(runtime, cookie, text) {
    const changes = watch(directory, { signal: AbortSignal.timeout(3000) })
    try {
      const changed = changes.next()
      const response = await send(runtime, chat + 'send', { cookie, json: { text } })
      assert.equal(response.status, 202)
      let event = await changed
      while (!/^room-.*[.]json$/.test(event.value?.filename ?? '')) {
        assert.equal(event.done, false)
        event = await changes.next()
      }
      return JSON.parse(response.text).requestId
    } finally { await changes.return() }
  }
  const alice = await login('alice')
  const bob = await login('bob')
  const outsider = await login('outsider')
  assert.equal((await send(first, chat + 'history', { cookie: outsider })).status, 403)
  assert.equal((await send(first, chat + 'send', { cookie: outsider, json: { text: 'denied' } })).status, 403)
  const aliceId = await turn(first, alice, 'Alice first')
  const bobId = await turn(first, bob, 'Bob second')
  assert.deepEqual(first.adapter.calls.map(call => call.text), [['Alice first'], ['Alice first', 'mock reply', 'Bob second']])
  const sessionId = first.adapter.calls[0].sessionId
  assert.ok(first.adapter.calls.every(call => call.sessionId === sessionId))
  const scope = personId => ({ nodeId, botId, roomId: 'general', personId, sessionId })
  for (const [owner, other, requestId] of [['alice', 'bob', aliceId], ['bob', 'alice', bobId]]) {
    assert.equal((await first.worker.status(scope(owner), requestId)).status, 'completed')
    assert.deepEqual(await first.worker.status(scope(other), requestId), { requestId, status: 'unknown' })
  }
  const before = await history(first, alice)
  assert.deepEqual(await history(first, bob), before)
  assert.deepEqual(before.map(row => [row.kind, row.by, row.name, row.text]), [
    ['user', 'alice', 'Alice', 'Alice first'], ['bot', botId, botId, 'mock reply'],
    ['user', 'bob', 'Bob', 'Bob second'], ['bot', botId, botId, 'mock reply'],
  ])
  await first.close()
  const restarted = await start(false)
  assert.deepEqual(await history(restarted, bob), before)
  assert.equal((await restarted.worker.status(scope('alice'), aliceId)).status, 'completed')
  const followupId = await turn(restarted, bob, 'Bob after restart')
  assert.equal((await restarted.worker.status(scope('bob'), followupId)).status, 'completed')
  assert.deepEqual(restarted.adapter.calls, [{ sessionId, text: ['Alice first', 'mock reply', 'Bob second', 'mock reply', 'Bob after restart'] }])
  const after = await history(restarted, alice)
  assert.deepEqual(after.slice(0, 4), before)
  assert.deepEqual(after.slice(4).map(row => [row.by, row.text]), [['bob', 'Bob after restart'], [botId, 'mock reply']])
})

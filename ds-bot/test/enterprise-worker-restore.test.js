import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
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


function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-worker-bootstrap-'))
  const profile = new Context()
  t.after(async () => {
    try { await profile.fiber.dispose() } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  const tls = makeTls(dir)
  const scope = { nodeId: 'mock-node', personId: 'employee', botId: 'helper' }
  const config = {
    nodeId: scope.nodeId, provider: 'mock', model: 'model', initialize: true,
    receiptPath: join(dir, 'receipts.json'),
    certPaths: { ca: join(dir, 'ca.pem'), cert: join(dir, 'server.pem'), key: join(dir, 'server.key') },
    peerGrants: [{ fingerprint: new X509Certificate(tls.controller.cert).fingerprint256,
      personId: scope.personId, botId: scope.botId, actions: ['create', 'submit', 'status'],
    }],
  }
  return { profile, tls, scope, config }
}


test('worker reuses native Session and history after restart and rejects foreign bindings', { timeout: 10000 }, async t => {
  const { profile, tls, scope, config } = fixture(t)
  config.mappingPath = config.receiptPath + '.mapping'
  config.sessionRoot = config.receiptPath + '.sessions'
  config.peerGrants.push({ ...config.peerGrants[0], personId: 'other' })
  const restored = new Context()
  t.after(() => restored.fiber.dispose())
  async function start(context, initialize) {
    const ready = Promise.withResolvers()
    const adapter = new MockModel()
    await context.plugin(createWorkerBootstrap({ config: { ...config, initialize }, adapter, onReady: ready.resolve }))
    const { origin } = await ready.promise
    const client = createWorkerClient({ origin, nodeId: scope.nodeId, transport: createWorkerTlsTransport({ ...tls.controller, origin }) })
    return { adapter, client }
  }
  const first = await start(profile, true)
  const [created, again] = await Promise.all([first.client.create(scope), first.client.create(scope)])
  assert.deepEqual(again, created)
  const owned = { ...scope, ...created }
  assert.equal((await first.client.submit(owned, 'original', 'first message')).status, 'completed')
  await profile.fiber.dispose()
  const second = await start(restored, false)
  await assert.rejects(second.client.submit({ ...owned, personId: 'other' }, 'foreign', 'foreign message'), { code: 'worker-refused', status: 403 })
  assert.deepEqual(second.adapter.calls, [])
  assert.equal((await second.client.submit(owned, 'next', 'second message')).status, 'completed')
  assert.deepEqual(await second.client.create(scope), created)
  assert.deepEqual(second.adapter.calls, [{ sessionId: created.sessionId, text: ['first message', 'mock reply', 'second message'] }])
  assert.equal((await second.client.status(owned, 'original')).status, 'completed')
})

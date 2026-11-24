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
import { apply } from '../src/host/enterprise/worker-plugin.js'
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
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'mock reply' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'mock reply' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('Cordis activation mounts a dedicated worker and its disposer closes mTLS', { timeout: 8000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-worker-plugin-'))
  const profile = new Context()
  t.after(async () => {
    try { await profile.fiber.dispose() } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  const tls = makeTls(dir)
  const fingerprint = new X509Certificate(tls.controller.cert).fingerprint256
  const scope = { nodeId: 'mock-node', personId: 'employee', botId: 'helper' }
  const owns = target => Object.keys(scope).every(key => target[key] === scope[key])
  const ready = Promise.withResolvers()
  await profile.plugin({ apply }, {
    nodeId: scope.nodeId, provider: 'mock', model: 'model', adapter: new MockModel(), initialize: true,
    receiptPath: join(dir, 'receipts.json'), tls: tls.server,
    authorizeSession: owns, authorizePeer: (identity, { scope: target }) => identity === fingerprint && owns(target),
    onReady: ready.resolve,
  })
  const { origin } = await ready.promise
  assert.equal(profile.get('agents'), undefined)
  assert.equal(profile.get('llm'), undefined)
  const transport = createWorkerTlsTransport({ ...tls.controller, origin })
  const client = createWorkerClient({ origin, nodeId: scope.nodeId, transport })
  await assert.rejects(client.create({ ...scope, personId: 'outsider' }), { code: 'worker-refused', status: 403 })
  const owned = { ...scope, ...await client.create(scope) }
  const events = []
  const receipt = await client.submit(owned, 'fixture-request', 'mock prompt', { onEvent: event => events.push(event) })
  assert.equal(receipt.status, 'completed')
  assert.deepEqual(events.map(event => event.text), ['mock reply', 'mock reply'])
  await profile.fiber.dispose()
  const request = new Request(origin + '/internal/enterprise/worker/status', {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...owned, requestId: 'fixture-request' }),
  })
  await assert.rejects(transport(request), { code: 'ECONNREFUSED' })
})

test('worker plugin fails closed before opening storage or announcing readiness', { timeout: 8000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-worker-plugin-invalid-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const tls = makeTls(dir)
  const config = {
    nodeId: 'mock-node', provider: 'mock', model: 'model', adapter: new MockModel(), initialize: true,
    receiptPath: join(dir, 'receipts.json'), tls: tls.server,
    authorizeSession: () => false, authorizePeer: () => false, onReady: () => assert.fail('unexpected readiness'),
  }
  await assert.rejects(apply(undefined, { ...config, authorizePeer: undefined }), /Invalid enterprise worker plugin configuration/)
  await assert.rejects(apply(undefined, { ...config, model: 'missing' }), /Unavailable fixture model/)
  assert.throws(() => readFileSync(config.receiptPath), { code: 'ENOENT' })
})

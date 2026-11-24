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



test('room grants require durable ownership and never inherit private access', { timeout: 10000 }, async t => {
  const { profile, tls, scope, config } = fixture(t)
  const roomGrant = { ...config.peerGrants[0], roomId: 'general' }
  const adapter = new MockModel()
  assert.throws(() => createWorkerBootstrap({ config: { ...config, peerGrants: [roomGrant] }, adapter }), /Invalid administrator/)
  config.mappingPath = config.receiptPath + '.mapping'
  config.sessionRoot = config.receiptPath + '.sessions'
  async function start(context, peerGrants) {
    const ready = Promise.withResolvers()
    await context.plugin(createWorkerBootstrap({ config: { ...config, peerGrants }, adapter, onReady: ready.resolve }))
    const { origin } = await ready.promise
    return createWorkerClient({ origin, nodeId: scope.nodeId, transport: createWorkerTlsTransport({ ...tls.controller, origin }) })
  }
  const refused = { code: 'worker-refused', status: 403 }
  const room = { ...scope, roomId: 'general' }
  const privateOnly = await start(profile, config.peerGrants)
  const personal = await privateOnly.create(scope)
  await assert.rejects(privateOnly.create(room), refused)
  await profile.fiber.dispose()
  const roomProfile = new Context()
  t.after(() => roomProfile.fiber.dispose())
  const bob = { ...room, personId: 'bob' }
  const client = await start(roomProfile, [...config.peerGrants, roomGrant, { ...roomGrant, personId: 'bob', actions: ['create'] }])
  await assert.rejects(client.create({ ...room, roomId: 'other' }), refused)
  await assert.rejects(client.create({ ...room, personId: 'outsider' }), refused)
  await assert.rejects(client.create({ ...scope, personId: 'bob' }), refused)
  const { sessionId } = await client.create(room)
  assert.notEqual(sessionId, personal.sessionId)
  assert.deepEqual(await client.create(bob), { sessionId })
  await assert.rejects(client.submit({ ...room, ...personal }, 'foreign', 'foreign private Session'), refused)
  await assert.rejects(client.submit({ ...bob, sessionId }, 'bob-denied', 'not granted'), refused)
  const receipt = await client.submit({ ...room, sessionId }, 'room-turn', 'mock room turn')
  assert.equal(receipt.status, 'completed')
  assert.deepEqual(await client.status({ ...room, sessionId }, 'room-turn'), receipt)
  assert.deepEqual(await client.status({ ...scope, sessionId }, 'room-turn'), { requestId: 'room-turn', status: 'unknown' })
  assert.deepEqual(adapter.calls, [{ sessionId, text: ['mock room turn'] }])
})

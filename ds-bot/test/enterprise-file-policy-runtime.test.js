import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBusinessFileAuthorization, matchRules } from '../src/host/enterprise/file-authorization.js'
import { createEmployeeRuleReader, openEmployeeRuleStore } from '../src/host/enterprise/rule-store.js'
import { createFileEvidenceTlsClient } from '../src/host/enterprise/file-evidence-tls.js'
import { startFilePolicyRuntime } from '../src/host/enterprise/file-policy-runtime.js'
import { createFileReservationTlsClient } from '../src/host/enterprise/file-reservation-tls.js'

const scope = { nodeId: 'node', personId: 'alice', botId: 'bot', roomId: 'room',
  sessionId: 'session', requestId: 'request', dispatchId: 'call', operation: 'modify',
  targetId: 'note', version: 'original', contentDigest: 'a'.repeat(64), ruleId: 'write', ruleVersion: 'one',
}
const refused = { code: 'reservation-refused' }
function makeTls(dir) {
  const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, timeout: 5000, stdio: 'ignore' })
  openssl('req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '1', '-subj', '/CN=Policy fixture CA',
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
    worker: issue('worker', ['extendedKeyUsage=clientAuth']),
    producer: issue('producer', ['extendedKeyUsage=clientAuth']),
  }
}


async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-policy-runtime-'))
  const instances = []
  t.after(async () => {
    try { await Promise.all(instances.map(runtime => runtime.close())) }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
  const tls = makeTls(dir)
  const fingerprint = new X509Certificate(tls.worker.cert).fingerprint256
  const trustedProducer = Symbol('fixture producer')
  const settings = {
    reservationFile: join(dir, 'reservations.json'), evidenceFile: join(dir, 'evidence.json'), trustedProducer,
    canReserve: input => input.ruleVersion === scope.ruleVersion,
    resolveWorker: verified => verified === fingerprint ? scope.nodeId : undefined,
    authorizeScope: (nodeId, _action, input) => nodeId === scope.nodeId && input.personId === scope.personId,
    listener: { tls: tls.server },
  }
  async function start(options) {
    const runtime = await startFilePolicyRuntime({ ...settings, ...options })
    instances.push(runtime)
    const client = createFileReservationTlsClient({ origin: runtime.origin, ...tls.worker })
    return { runtime, client }
  }
  const separated = { resolveWorker: undefined, workerGrants: [{ fingerprint, nodeId: scope.nodeId }], evidenceListener: {
    tls: tls.server, producerGrants: [{ fingerprint: new X509Certificate(tls.producer.cert).fingerprint256, nodeId: scope.nodeId }],
  } }
  return { settings, trustedProducer, start, tls, separated }
}

const posix = { timeout: 8000, skip: process.platform === 'win32' }

test('policy runtime preserves pending revocation and trusted evidence across restart', posix, async t => {
  const { start, trustedProducer } = await fixture(t)
  const first = await start({ initialize: true })
  const proof = { scope, status: 'completed', evidenceId: 'effect-a' }
  await assert.rejects(first.client.reserve({ ...scope, ruleVersion: 'stale' }), refused)
  assert.deepEqual(await first.client.reserve(scope), { issued: true, status: 'reserved' })
  assert.equal(await first.runtime.revoke(scope.personId), 'pending')
  await assert.rejects(first.client.settle(scope, proof.status, proof.evidenceId), refused)
  await assert.rejects(first.runtime.ingest(Symbol('untrusted'), proof), { code: 'not-authorized' })
  assert.equal(await first.runtime.revoke(scope.personId), 'pending')
  assert.deepEqual(await first.runtime.ingest(trustedProducer, proof), { inserted: true })
  const closing = first.runtime.close()
  assert.equal(first.runtime.close(), closing)
  await closing
  await assert.rejects(first.client.reserve(scope), { code: 'reservation-outcome-unknown' })
  await assert.rejects(first.runtime.ingest(trustedProducer, proof), { code: 'invalid-settlement-evidence' })
  const second = await start()
  assert.equal(await second.runtime.revoke(scope.personId), 'pending')
  await assert.rejects(second.client.settle({ ...scope, targetId: 'other' }, proof.status, proof.evidenceId), refused)
  await assert.rejects(second.client.settle(scope, 'fenced', proof.evidenceId), refused)
  assert.deepEqual(await second.client.settle(scope, proof.status, proof.evidenceId), { revocation: 'revoked' })
  assert.deepEqual(await second.client.reserve(scope), { issued: false, status: 'completed' })
})

test('policy runtime releases both stores if the mTLS listener cannot bind', posix, async t => {
  const { settings, start } = await fixture(t)
  const busy = await start({ initialize: true, reservationFile: settings.reservationFile + '.busy', evidenceFile: settings.evidenceFile + '.busy' })
  await assert.rejects(start({ initialize: true, listener: { ...settings.listener, port: busy.runtime.address.port } }), { code: 'EADDRINUSE' })
  const reopened = await start()
  assert.deepEqual(await reopened.client.reserve(scope), { issued: true, status: 'reserved' })
})

test('policy runtime releases the reservation store when opening evidence fails', posix, async t => {
  const { settings, start } = await fixture(t)
  writeFileSync(settings.evidenceFile, 'corrupt fixture', { mode: 0o600 })
  await assert.rejects(start({ initialize: true }), { code: 'invalid-settlement-evidence' })
  assert.equal(readFileSync(settings.evidenceFile, 'utf8'), 'corrupt fixture')
  const recovered = await start({ initialize: true, evidenceFile: settings.evidenceFile + '.recovered' })
  assert.deepEqual(await recovered.client.reserve(scope), { issued: true, status: 'reserved' })
})

test('evidence listener requires explicit disjoint registries and settles exact evidence after restart', posix, async t => {
  const { settings, start, tls, separated } = await fixture(t)
  await assert.rejects(start({ ...separated, resolveWorker: settings.resolveWorker }), /explicit worker and producer registries/)
  await assert.rejects(start({ ...separated, workerGrants: undefined }), /identity registry/)
  await assert.rejects(start({ ...separated, workerGrants: separated.evidenceListener.producerGrants }), /registries overlap/)
  const [worker] = separated.workerGrants
  await assert.rejects(start({ ...separated, workerGrants: [{ ...worker, fingerprint: worker.fingerprint.toLowerCase() }] }), /identity grant/)
  const first = await start({ ...separated, initialize: true })
  const proof = { scope, status: 'completed', evidenceId: 'effect-a' }
  const publish = createFileEvidenceTlsClient({ origin: first.runtime.evidenceOrigin, ...tls.producer })
  const unauthorized = createFileEvidenceTlsClient({ origin: first.runtime.evidenceOrigin, ...tls.worker })
  const producerOnReservations = createFileReservationTlsClient({ origin: first.runtime.origin, ...tls.producer })
  await assert.rejects(producerOnReservations.reserve(scope), refused)
  await assert.rejects(unauthorized(proof), { code: 'evidence-refused' })
  await assert.rejects(publish({ ...proof, scope: { ...scope, nodeId: 'different' } }), { code: 'evidence-refused' })
  assert.deepEqual(await first.client.reserve(scope), { issued: true, status: 'reserved' })
  assert.equal(await first.runtime.revoke(scope.personId), 'pending')
  await assert.rejects(first.client.settle(scope, proof.status, proof.evidenceId), refused)
  assert.deepEqual(await publish(proof), { inserted: true })
  assert.deepEqual(await publish(proof), { inserted: false })
  await first.runtime.close()
  await assert.rejects(publish(proof), { code: 'evidence-outcome-unknown' })
  await assert.rejects(first.client.reserve(scope), { code: 'reservation-outcome-unknown' })

  const reopened = await start(separated)
  const retry = createFileEvidenceTlsClient({ origin: reopened.runtime.evidenceOrigin, ...tls.producer })
  assert.deepEqual(await retry(proof), { inserted: false })
  assert.equal(await reopened.runtime.revoke(scope.personId), 'pending')
  await assert.rejects(reopened.client.settle({ ...scope, targetId: 'other' }, proof.status, proof.evidenceId), refused)
  assert.deepEqual(await reopened.client.settle(scope, proof.status, proof.evidenceId), { revocation: 'revoked' })
})

test('policy runtime rolls back its reservation listener when evidence binding fails', posix, async t => {
  const { start, settings, separated } = await fixture(t)
  const socket = createServer()
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve))
  const closeSocket = () => new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()))
  const { port } = socket.address()
  await closeSocket()
  const binding = { ...separated, listener: { ...settings.listener, port },
    evidenceListener: { ...separated.evidenceListener, port },
  }
  await assert.rejects(start({ ...binding, initialize: true }), { code: 'EADDRINUSE' })
  const recovered = await start({ ...binding, evidenceListener: separated.evidenceListener })
  assert.equal(recovered.runtime.address.port, port)
  assert.notEqual(recovered.runtime.evidenceAddress.port, port)
  assert.deepEqual(await recovered.client.reserve(scope), { issued: true, status: 'reserved' })
})

test('shared rule file controls worker matching and new central reservations', posix, async t => {
  const { start, settings, trustedProducer } = await fixture(t)
  const file = join(settings.reservationFile, '..', 'rules.json')
  const writer = await openEmployeeRuleStore(file, { initialize: true })
  const readRules = createEmployeeRuleReader(file)
  const worker = createBusinessFileAuthorization({ readRules, isAuthorized: () => true })
  let request = 0
  const update = (action, rule) => writer.change({ requestId: 'owner-' + ++request, at: request }, { action, rule }, () => true)
  const base = { id: 'create-only', personId: scope.personId, botId: scope.botId, roomId: scope.roomId,
    directory: '/files', operation: 'create', effect: 'allow', purpose: 'Fixture business purpose' }
  await update('create', base)
  const target = '/files/work/note'
  const { client, runtime } = await start({ initialize: true, ruleFile: file, canReserve: undefined,
    resolveTarget: (id, input) => id === 'note' && input.nodeId === 'node' ? target : undefined })
  const create = { ...scope, operation: 'create', version: null, ruleId: base.id, ruleVersion: '1' }
  const workerInput = input => {
    const { personId, botId, roomId, sessionId, requestId, dispatchId, operation, version, contentDigest } = input
    return { personId, botId, roomId, sessionId, requestId, dispatchId, operation, version, contentDigest, path: target }
  }
  assert.equal(worker.prepare(workerInput(scope)), undefined)
  assert.equal(worker.prepare(workerInput(create))?.ruleVersion, '1')
  await assert.rejects(client.reserve({ ...scope, ruleId: base.id, ruleVersion: '1' }), refused)
  await assert.rejects(client.reserve({ ...create, targetId: 'unmapped' }), refused)
  assert.deepEqual(await client.reserve(create), { issued: true, status: 'reserved' })
  const evidence = { scope: create, status: 'completed', evidenceId: 'evidence' }
  await runtime.ingest(trustedProducer, evidence)
  await client.settle(create, evidence.status, evidence.evidenceId)
  await update('create', { ...base, id: 'more-specific', directory: '/files/work' })
  assert.equal(worker.prepare(workerInput({ ...create, dispatchId: 'more' }))?.ruleId, 'more-specific')
  await assert.rejects(client.reserve({ ...create, dispatchId: 'stale' }), refused)
  await assert.rejects(client.reserve({ ...create, dispatchId: 'loses', ruleVersion: '2' }), refused)
  const good = readFileSync(file)
  writeFileSync(file, good.subarray(0, good.length / 2))
  assert.equal(worker.prepare(workerInput({ ...create, dispatchId: 'broken' })), undefined)
  await assert.rejects(client.reserve({ ...create, dispatchId: 'broken', ruleVersion: '2', ruleId: 'more-specific' }), refused)
  writeFileSync(file, good)
  assert.equal(readRules().version, '2')
  await update('edit', { ...base, effect: 'deny' })
  assert.equal(worker.prepare(workerInput({ ...create, dispatchId: 'blocked' })), undefined)
  await assert.rejects(client.reserve({ ...create, dispatchId: 'blocked', ruleVersion: '3', ruleId: 'more-specific' }), refused)
  await update('retire', { id: base.id })
  await update('retire', { id: 'more-specific' })
  assert.equal(readRules().version, '5')
  await assert.rejects(client.reserve({ ...create, dispatchId: 'retired', ruleVersion: '5' }), refused)
  assert.deepEqual(await client.reserve(create), { issued: false, status: 'completed' })
  assert.equal(createEmployeeRuleReader(file)().version, '5')
  const changes = JSON.parse(readFileSync(file)).changes
  assert.deepEqual(changes.map(({ version, ownerRequestId, at, rule }) => [version, ownerRequestId, at, rule.id]),
    [[1, 'owner-1', 1, base.id], [2, 'owner-2', 2, 'more-specific'], [3, 'owner-3', 3, base.id],
      [4, 'owner-4', 4, base.id], [5, 'owner-5', 5, 'more-specific']])
  const { operation: _, ...legacy } = base
  assert.equal(matchRules({ version: 'legacy', rules: [{ ...legacy, grant: 'write' }] }, workerInput(scope))?.rule.id, base.id)
  assert.equal(matchRules({ version: 'explicit', rules: [{ ...base, grant: 'write' }] }, workerInput(scope)), undefined)
})

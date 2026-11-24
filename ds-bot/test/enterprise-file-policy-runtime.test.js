import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
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
  return { settings, trustedProducer, start }
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

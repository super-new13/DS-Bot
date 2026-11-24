import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openFileEffectOutbox } from '../src/host/enterprise/file-effect-outbox.js'
import { createFileSettlementDelivery } from '../src/host/enterprise/file-settlement-delivery.js'
import { createFileEvidenceTlsClient } from '../src/host/enterprise/file-evidence-tls.js'
import { startFilePolicyRuntime } from '../src/host/enterprise/file-policy-runtime.js'
import { createFileReservationTlsClient } from '../src/host/enterprise/file-reservation-tls.js'

const scope = { nodeId: 'node', personId: 'alice', botId: 'bot', roomId: 'room',
  sessionId: 'session', requestId: 'request', dispatchId: 'call', operation: 'modify',
  targetId: 'note', version: 'original', contentDigest: 'a'.repeat(64), ruleId: 'write', ruleVersion: 'one',
}
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

for (const lost of ['ingest', 'settle']) {
  test('outbox recovers a lost ' + lost + ' response with the same evidence after restart', posix, async t => {
    const { start, tls, separated, settings } = await fixture(t)
    const file = join(settings.reservationFile, '..', 'outbox.json')
    let outbox = await openFileEffectOutbox(file, { initialize: true })
    try {
      const first = await start({ ...separated, initialize: true })
      const publish = createFileEvidenceTlsClient({ origin: first.runtime.evidenceOrigin, ...tls.producer })
      assert.deepEqual(await first.client.reserve(scope), { issued: true, status: 'reserved' })
      assert.equal(await first.runtime.revoke(scope.personId), 'pending')
      await outbox.onCompleted({ scope, status: 'completed' })
      const [saved] = JSON.parse(readFileSync(file, 'utf8')).entries
      const lostReply = new Error('Fixture response lost')
      let settlements = 0
      const deliver = createFileSettlementDelivery({
        async ingest(entry, options) {
          assert.deepEqual(entry, saved)
          assert.deepEqual(await publish(entry, options), { inserted: true })
          if (lost === 'ingest') throw lostReply
          return { inserted: true }
        },
        reservations: { async settle(exactScope, status, evidenceId, options) {
          settlements++
          assert.deepEqual(exactScope, scope)
          assert.equal(status, 'completed')
          assert.equal(evidenceId, saved.evidenceId)
          assert.deepEqual(await first.client.settle(exactScope, status, evidenceId, options), { revocation: 'revoked' })
          throw lostReply
        } },
      })
      await assert.rejects(outbox.drain(deliver), error => error === lostReply)
      assert.equal(settlements, lost === 'ingest' ? 0 : 1)
      assert.equal(await first.runtime.revoke(scope.personId), lost === 'ingest' ? 'pending' : 'revoked')
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).entries, [saved])
      await first.runtime.close()
      await outbox.close()

      const second = await start(separated)
      outbox = await openFileEffectOutbox(file)
      const retryPublish = createFileEvidenceTlsClient({ origin: second.runtime.evidenceOrigin, ...tls.producer })
      const retry = createFileSettlementDelivery({
        async ingest(entry, options) {
          assert.deepEqual(entry, saved)
          const result = await retryPublish(entry, options)
          assert.deepEqual(result, { inserted: false })
          return result
        },
        reservations: second.client,
      })
      assert.deepEqual(await outbox.drain(retry), { acknowledged: 1 })
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).entries, [])
      assert.deepEqual(await second.client.reserve(scope), { issued: false, status: 'completed' })
      assert.equal(await second.runtime.revoke(scope.personId), 'revoked')
    } finally { await outbox.close() }
  })
}

test('delivery requires both acknowledgments and stops before settlement after abort', async () => {
  const entry = { scope, status: 'completed', evidenceId: 'record' }
  const controller = new AbortController()
  let called = 0
  const reservations = { settle() { called++; return { revocation: 'pending' } } }
  const failure = { code: 'settlement-delivery-unknown' }
  await assert.rejects(createFileSettlementDelivery({ ingest: () => ({}), reservations })(entry), failure)
  const interrupted = createFileSettlementDelivery({ ingest() { controller.abort(); return { inserted: false } }, reservations })
  await assert.rejects(interrupted(entry, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(called, 0)
  const unknown = createFileSettlementDelivery({ ingest: () => ({ inserted: false }), reservations: { settle: () => ({ revocation: 'unknown' }) } })
  await assert.rejects(unknown(entry), failure)
  assert.deepEqual(await createFileSettlementDelivery({ ingest: () => ({ inserted: false }), reservations })(entry), { inserted: false })
  assert.equal(called, 1)
})

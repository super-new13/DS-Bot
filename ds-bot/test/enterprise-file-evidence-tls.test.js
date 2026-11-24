import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openFileEffectOutbox } from '../src/host/enterprise/file-effect-outbox.js'
import { createFileEvidenceTlsClient, startFileEvidenceTls } from '../src/host/enterprise/file-evidence-tls.js'
import { openFileSettlementEvidence } from '../src/host/enterprise/file-settlement-evidence.js'

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
    worker: issue('worker', ['extendedKeyUsage=clientAuth']), stranger: issue('stranger', ['extendedKeyUsage=clientAuth']),
  }
}

const path = '/internal/enterprise/file-evidence/ingest'
const scope = { nodeId: 'node', personId: 'alice', botId: 'bot', roomId: null,
  sessionId: 'session', requestId: 'request', dispatchId: 'call', targetId: 'note',
  operation: 'modify', version: 'previous', contentDigest: 'a'.repeat(64), ruleId: 'rule', ruleVersion: 'v1',
}
const entry = { scope, status: 'completed', evidenceId: 'fixture-evidence' }
const refused = { code: 'evidence-refused' }
const unknown = { code: 'evidence-outcome-unknown' }

function post(origin, route, tls, payload, fingerprint) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = request(origin + route, { ...tls, agent: false, method: 'POST', signal: AbortSignal.timeout(3000),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-peer-fingerprint': fingerprint },
    }, response => { response.resume(); resolve(response.statusCode) })
    req.once('error', reject)
    req.end(body)
  })
}

test('dedicated producer delivers exact evidence and retries a lost acknowledgment without duplication',
  { skip: process.platform === 'win32', timeout: 10000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'dsbot-evidence-tls-'))
    const resources = []
    t.after(async () => {
      try { await Promise.all(resources.map(resource => resource.close())) }
      finally { rmSync(dir, { recursive: true, force: true }) }
    })
    const { server, worker, stranger: producer } = makeTls(dir)
    const fingerprint = new X509Certificate(producer.cert).fingerprint256
    const trustedProducer = Symbol('fixture evidence producer')
    const center = await openFileSettlementEvidence(join(dir, 'center.json'), { initialize: true, trustedProducer })
    resources.push(center)
    const lost = new AbortController()
    let interrupt = false
    const ingested = []
    const listener = await startFileEvidenceTls({ tls: server, maxBodyBytes: 2048,
      producerGrants: [{ fingerprint, nodeId: scope.nodeId }],
      async ingest(proof) {
        const result = await center.ingest(trustedProducer, proof)
        ingested.push({ proof, result })
        if (interrupt) { interrupt = false; lost.abort() }
        return result
      },
    })
    resources.push(listener)
    const { origin } = listener
    assert.equal(await post(origin, path, worker, entry, fingerprint), 403)
    assert.equal(await post(origin, '/internal/enterprise/file-reservations/settle', producer, entry, fingerprint), 404)
    assert.equal(await post(origin, path, producer, { ...entry, status: 'fenced' }, fingerprint), 400)
    assert.equal(await post(origin, path, producer, { ...entry, scope: { ...scope, path: 'extra' } }, fingerprint), 400)
    assert.equal(await post(origin, path, producer, { ...entry, extra: 'x'.repeat(2048) }, fingerprint), 413)
    const publish = createFileEvidenceTlsClient({ origin, ...producer })
    await assert.rejects(publish({ ...entry, scope: { ...scope, nodeId: 'other' } }), refused)
    assert.deepEqual(ingested, [])

    const file = join(dir, 'outbox.json')
    const outbox = await openFileEffectOutbox(file, { initialize: true })
    resources.push(outbox)
    await outbox.onCompleted({ scope, status: 'completed' })
    interrupt = true
    await assert.rejects(outbox.drain((proof, { signal }) => publish(proof, { signal: AbortSignal.any([signal, lost.signal]) })), unknown)
    assert.equal(ingested.length, 1)
    assert.deepEqual(ingested[0].result, { inserted: true })
    assert.equal(await center.verifySettlement(scope.nodeId, ingested[0].proof), true)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).entries, [ingested[0].proof])
    await outbox.close()

    const reopened = await openFileEffectOutbox(file)
    resources.push(reopened)
    assert.deepEqual(await reopened.drain(publish), { acknowledged: 1 })
    assert.deepEqual(ingested[1], { proof: ingested[0].proof, result: { inserted: false } })
    assert.deepEqual(await reopened.drain(publish), { acknowledged: 0 })
    assert.equal(ingested.length, 2)
  })

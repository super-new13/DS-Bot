import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openFileReservationStore } from '../src/host/enterprise/file-reservation-store.js'
import { createFileReservations } from '../src/host/enterprise/file-reservations.js'
import { createFileReservationTlsClient, startFileReservationTls } from '../src/host/enterprise/file-reservation-tls.js'

const root = '/internal/enterprise/file-reservations/'
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
    worker: issue('worker', ['extendedKeyUsage=clientAuth']), stranger: issue('stranger', ['extendedKeyUsage=clientAuth']),
  }
}

function raw(origin, path, tls, payload, fingerprint) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = request(origin + path, { ...tls, agent: false, method: 'POST', signal: AbortSignal.timeout(2000),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-peer-fingerprint': fingerprint },
    }, response => { response.resume(); resolve(response.statusCode) })
    req.once('error', reject)
    req.end(body)
  })
}

test('mTLS reservations survive lost responses and settle only with exact evidence', { timeout: 8000, skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsbot-policy-tls-'))
  const instances = []
  t.after(async () => {
    try { await Promise.all(instances.map(instance => instance.close())) }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
  const tls = makeTls(dir)
  const store = await openFileReservationStore(join(dir, 'reservations.json'), { initialize: true })
  instances.push(store)
  const policy = createFileReservations({ transact: store.transact, canReserve: () => true })
  const fingerprint = new X509Certificate(tls.worker.cert).fingerprint256
  const responseLost = new AbortController()
  let calls = 0
  let evidence
  const entry = await startFileReservationTls({ tls: tls.server,
    reservations: { ...policy, async reserve(input) {
      calls++
      const result = await policy.reserve(input)
      if (calls === 1) responseLost.abort()
      return result
    } },
    resolveWorker: verified => verified === fingerprint ? scope.nodeId : undefined,
    authorizeScope: (_node, _action, proposed) => proposed.personId === scope.personId && proposed.roomId === scope.roomId,
    verifySettlement: (nodeId, proposed) => proposed.evidenceId === 'effect-a' && proposed.status === evidence?.status
      && nodeId === evidence.scope.nodeId && Object.keys(scope).every(key => proposed.scope[key] === evidence.scope[key]),
  })
  instances.unshift(entry)
  assert.equal(await raw(entry.origin, root + 'reserve', tls.stranger, { scope }, fingerprint), 403)
  assert.equal(await raw(entry.origin, '/internal/enterprise/worker/status', tls.worker, {}, fingerprint), 404)
  const client = createFileReservationTlsClient({ origin: entry.origin, ...tls.worker })
  await assert.rejects(client.reserve({ ...scope, nodeId: 'other' }), refused)
  await assert.rejects(client.reserve({ ...scope, personId: 'bob' }), refused)
  await assert.rejects(client.reserve(scope, { signal: responseLost.signal }), { code: 'reservation-outcome-unknown' })
  assert.equal(calls, 1)
  assert.equal(await policy.revoke('alice'), 'pending')
  assert.deepEqual(await client.reserve(scope), { issued: false, status: 'reserved' })
  await assert.rejects(client.reserve({ ...scope, dispatchId: 'another' }), refused)
  await assert.rejects(client.settle(scope, 'unknown', 'effect-a'), refused)
  await assert.rejects(client.settle(scope, 'completed', 'effect-a'), refused)
  assert.equal(await policy.revoke('alice'), 'pending')
  evidence = { scope, status: 'completed' }
  assert.deepEqual(await client.settle(scope, 'completed', 'effect-a'), { revocation: 'revoked' })
  assert.deepEqual(await client.reserve(scope), { issued: false, status: 'completed' })
})

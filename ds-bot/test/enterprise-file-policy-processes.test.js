import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createFileEvidenceTlsClient } from '../src/host/enterprise/file-evidence-tls.js'
import { createFileReservationTlsClient } from '../src/host/enterprise/file-reservation-tls.js'
import { createWorkerClient } from '../src/host/enterprise/worker-client.js'
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
    controller: issue('controller', ['extendedKeyUsage=clientAuth']),
    worker: issue('worker', ['extendedKeyUsage=clientAuth']),
    producer: issue('producer', ['extendedKeyUsage=clientAuth']),
  }
}


const script = new URL('./fixtures/enterprise-file-policy-process.mjs', import.meta.url)
const resolver = fileURLToPath(new URL('./harness-resolve.mjs', import.meta.url))

function runProcess(dir, role, ...args) {
  const child = fork(script, [role, dir, ...args], { cwd: dir, execArgv: ['--import', resolver],
    env: { DSH_HOME: join(dir, role + '-home'), DSH_TELEMETRY_DISABLED: '1',
      DSH_HARNESS: resolve(process.env.DSH_HARNESS ?? fileURLToPath(new URL('../dev/harness/', import.meta.url))),
    },
  })
  const exited = once(child, 'exit')
  void exited.catch(() => {})
  async function receive(action) {
    const signal = AbortSignal.timeout(5000)
    const reply = once(child, 'message', { signal })
    if (action) child.send(action)
    const [message] = await Promise.race([reply, exited.then(([code]) => { throw new Error(role + ' exited with ' + code) })])
    if (message.error) throw new Error(message.error)
    return message
  }
  async function close() {
    child.send('close')
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000)
    try { assert.deepEqual(await exited, [0, null]) } finally { clearTimeout(timer) }
  }
  return { child, exited, receive, close }
}

test('separate worker and policy processes settle one guarded file write',
  { timeout: 15000, skip: process.platform === 'win32' }, async t => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'dsbot-policy-processes-'))
    const processes = []
    t.after(async () => {
      for (const { child } of processes) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await Promise.allSettled(processes.map(process => process.exited))
      rmSync(dir, { recursive: true, force: true })
    })
    const tls = makeTls(dir)
    const root = join(dir, 'owned')
    mkdirSync(root, { mode: 0o700 })
    const path = join(root, 'note')
    writeFileSync(path, 'initial')
    const center = runProcess(dir, 'center')
    processes.push(center)
    const { reservationOrigin, evidenceOrigin } = await center.receive()
    const worker = runProcess(dir, 'worker', reservationOrigin, evidenceOrigin)
    processes.push(worker)
    const { origin } = await worker.receive()
    assert.notEqual(worker.child.pid, center.child.pid)
    assert.notEqual(new X509Certificate(tls.worker.cert).fingerprint256, new X509Certificate(tls.producer.cert).fingerprint256)
    const scope = { nodeId: 'node', personId: 'alice', botId: 'helper' }
    const client = createWorkerClient({ origin, nodeId: scope.nodeId, transport: createWorkerTlsTransport({ ...tls.controller, origin }) })
    const owned = { ...scope, ...await client.create(scope) }
    assert.equal((await client.submit(owned, 'fixture-request', 'Write the fixture note')).status, 'completed')
    assert.equal(readFileSync(path, 'utf8'), 'updated')
    const entries = name => JSON.parse(readFileSync(join(dir, name), 'utf8')).entries
    assert.equal(entries('outbox.json').length, 1)
    const [proof] = entries('outbox.json')
    assert.equal(proof.scope.sessionId, owned.sessionId)
    assert.equal(proof.scope.requestId, 'fixture-request')
    const ordinary = createFileEvidenceTlsClient({ origin: evidenceOrigin, ...tls.worker })
    await assert.rejects(ordinary(proof), { code: 'evidence-refused' })
    const reservations = createFileReservationTlsClient({ origin: reservationOrigin, ...tls.worker })
    assert.deepEqual(await center.receive('revoke'), { result: 'pending' })
    await assert.rejects(reservations.reserve({ ...proof.scope, requestId: 'fresh' }), { code: 'reservation-refused' })
    await assert.rejects(reservations.settle(proof.scope, proof.status, proof.evidenceId), { code: 'reservation-refused' })
    assert.deepEqual(await worker.receive('drain'), { result: { acknowledged: 1 } })
    assert.deepEqual(entries('evidence.json'), [proof])
    assert.deepEqual(entries('outbox.json'), [])
    assert.deepEqual(await center.receive('revoke'), { result: 'revoked' })
    assert.deepEqual(await reservations.reserve(proof.scope), { issued: false, status: 'completed' })
    await worker.close()
    await center.close()
    await assert.rejects(reservations.reserve(proof.scope), { code: 'reservation-outcome-unknown' })
    assert.equal((await client.status(owned, 'fixture-request')).status, 'unknown')
  })

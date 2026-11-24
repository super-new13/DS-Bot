import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { startFilePolicyBootstrap } from '../src/host/enterprise/file-policy-bootstrap.js'
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
    producer: issue('producer', ['extendedKeyUsage=clientAuth']),
  }
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


class FileModel extends MockModel {
  called = false
  async *stream() {
    if (this.called) { yield* super.stream(); return }
    this.called = true
    const name = 'worker_replace_file'
    const id = 'fixture-call'
    yield { type: 'block-start', index: 0, blockType: 'tool-call', id, name }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify({ content: 'updated' }) } }
    yield { type: 'finish', reason: { kind: 'tool-use' } }
  }
}

test('trusted bootstrap isolates credentials, rolls back failed startup and settles the exact worker completion',
  { timeout: 10000, skip: process.platform === 'win32' }, async t => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'dsbot-policy-bootstrap-'))
    let running
    t.after(async () => {
      try { await running?.close() } finally { rmSync(dir, { recursive: true, force: true }) }
    })
    const tls = makeTls(dir)
    const root = join(dir, 'owned')
    mkdirSync(root, { mode: 0o700 })
    const path = join(root, 'note')
    writeFileSync(path, 'initial')
    const scope = { nodeId: 'node', personId: 'alice', botId: 'helper' }
    const fingerprint = credentials => new X509Certificate(credentials.cert).fingerprint256
    const grant = credentials => ({ fingerprint: fingerprint(credentials), nodeId: scope.nodeId })
    const reservationFile = join(dir, 'reservations.json')
    const evidenceFile = join(dir, 'evidence.json')
    const outboxFile = join(dir, 'outbox.json')
    const requests = []
    let policyEnabled = true
    const options = {
      workerCredentials: tls.controller, producerCredentials: tls.producer,
      policy: { reservationFile, evidenceFile, initialize: true, listener: { tls: tls.server },
        workerGrants: [grant(tls.controller)], evidenceListener: { tls: tls.server, producerGrants: [grant(tls.producer)] },
        authorizeScope: (nodeId, _action, input) => nodeId === scope.nodeId && input.personId === scope.personId,
        canReserve(input) { requests.push(input); return policyEnabled && input.targetId === 'note' && input.ruleVersion === 'v1' },
      },
      worker: { adapter: new FileModel(), config: { nodeId: scope.nodeId, provider: 'mock', model: 'model', initialize: true,
        outboxFile, receiptPath: join(dir, 'receipts.json'),
        certPaths: { ca: join(dir, 'ca.pem'), cert: join(dir, 'server.pem'), key: join(dir, 'server.key') },
        peerGrants: [{ fingerprint: fingerprint(tls.controller), personId: scope.personId, botId: scope.botId, actions: ['create', 'submit', 'status'] }],
      }, fileTools: { root, path, targetId: 'note', workerOwned: true, isAuthorized: () => true,
        readRules: () => ({ version: 'v1', rules: [{ id: 'edit', personId: scope.personId, botId: scope.botId, roomId: null,
          directory: root, grant: 'write', effect: 'allow', purpose: 'Update fixture note',
        }] }),
        adjudicate: ({ rule }) => ({ verdict: 'allow', ruleId: rule.id, ruleVersion: rule.version, reason: 'Fixture approval' }),
      } },
    }
    await assert.rejects(startFilePolicyBootstrap({ ...options, producerCredentials: tls.controller }), /credentials overlap/)
    await assert.rejects(startFilePolicyBootstrap({ ...options, producerCredentials: undefined }), /independently provisioned/)
    await assert.rejects(startFilePolicyBootstrap({ ...options, policy: { ...options.policy, evidenceFile: outboxFile } }), /storage paths overlap/)
    assert.throws(() => readFileSync(reservationFile), { code: 'ENOENT' })
    await assert.rejects(startFilePolicyBootstrap({ ...options, worker: { ...options.worker,
      config: { ...options.worker.config, model: 'missing' },
    } }), /Unavailable fixture model/)

    running = await startFilePolicyBootstrap(options)
    const client = createWorkerClient({ origin: running.workerOrigin, nodeId: scope.nodeId,
      transport: createWorkerTlsTransport({ origin: running.workerOrigin, ...tls.controller }),
    })
    const owned = { ...scope, ...await client.create(scope) }
    assert.equal((await client.submit(owned, 'fixture-request', 'Update the fixture')).status, 'completed')
    assert.equal(readFileSync(path, 'utf8'), 'updated')
    assert.equal(requests.length, 1)
    const [saved] = JSON.parse(readFileSync(outboxFile, 'utf8')).entries
    assert.deepEqual(saved.scope, requests[0])
    assert.equal(saved.scope.sessionId, owned.sessionId)
    const reservation = createFileReservationTlsClient({ origin: running.reservationOrigin, ...tls.controller })
    policyEnabled = false
    await assert.rejects(reservation.reserve({ ...saved.scope, requestId: 'policy-disabled' }), { code: 'reservation-refused' })
    assert.equal(requests.length, 2)
    assert.equal(await running.revoke(scope.personId), 'pending')
    assert.deepEqual(await running.drainEvidence(), { acknowledged: 1 })
    assert.equal(await running.revoke(scope.personId), 'revoked')
    assert.deepEqual(await reservation.reserve(saved.scope), { issued: false, status: 'completed' })
    assert.deepEqual(JSON.parse(readFileSync(evidenceFile, 'utf8')).entries, [saved])
    assert.deepEqual(JSON.parse(readFileSync(outboxFile, 'utf8')).entries, [])
    await running.close()
    await assert.rejects(reservation.reserve(saved.scope), { code: 'reservation-outcome-unknown' })
  })

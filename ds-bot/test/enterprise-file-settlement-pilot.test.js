import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startFilePolicyRuntime } from '../src/host/enterprise/file-policy-runtime.js'
import { createFileReservationTlsClient } from '../src/host/enterprise/file-reservation-tls.js'

import { createWorkerFileDispatch } from '../src/host/enterprise/file-dispatch.js'
import { createWorkerFileEffects } from '../src/host/enterprise/file-effects.js'

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

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const unknown = { code: 'reservation-outcome-unknown' }

test('a guarded write can settle only after exact independent evidence reaches the center',
  { timeout: 10000, skip: process.platform === 'win32' }, async t => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'dsbot-settlement-pilot-'))
    const stalled = Promise.withResolvers()
    const entered = Promise.withResolvers()
    const runtimes = []
    t.after(async () => {
      stalled.resolve()
      try { await Promise.all(runtimes.map(runtime => runtime.close())) }
      finally { rmSync(dir, { recursive: true, force: true }) }
    })
    const tls = makeTls(dir)
    const fingerprint = new X509Certificate(tls.worker.cert).fingerprint256
    const root = join(dir, 'owned')
    mkdirSync(root, { mode: 0o700 })
    const path = join(root, 'note')
    writeFileSync(path, 'initial')
    const content = Buffer.from('approved replacement')
    const guard = createWorkerFileEffects({ root, workerOwned: true, authorization: { consume: () => false } })
    const version = guard.inspectVersion(path)
    const actor = { personId: 'alice', botId: 'helper', roomId: null,
      sessionId: 'session', requestId: 'request', dispatchId: 'dispatch',
    }
    const scope = Object.freeze({ ...actor, nodeId: 'worker', operation: 'modify', targetId: 'note', version,
      contentDigest: digest(content), ruleId: 'edit', ruleVersion: 'v1',
    })
    const trustedProducer = Symbol('fixture evidence producer')
    const proof = Object.freeze({ scope, status: 'completed', evidenceId: 'fixture-effect' })
    let stallIdentity = false
    async function start(initialize) {
      const runtime = await startFilePolicyRuntime({
        reservationFile: join(dir, 'reservations.json'), evidenceFile: join(dir, 'evidence.json'), initialize, trustedProducer,
        canReserve: proposed => proposed.ruleVersion === scope.ruleVersion && proposed.ruleId === scope.ruleId,
        async resolveWorker(verified) {
          if (verified !== fingerprint) return undefined
          if (stallIdentity) { entered.resolve(); await stalled.promise }
          return scope.nodeId
        },
        authorizeScope: (nodeId, _action, proposed) => nodeId === scope.nodeId && proposed.personId === actor.personId,
        listener: { tls: tls.server },
      })
      runtimes.push(runtime)
      const client = createFileReservationTlsClient({ origin: runtime.origin, ...tls.worker })
      return { runtime, client }
    }

    const { runtime, client } = await start(true)
    let permit = false
    const outcomes = []
    const dispatch = createWorkerFileDispatch({ root, workerOwned: true,
      isAuthorized: action => permit && Object.keys(actor).every(key => action[key] === actor[key])
        && action.operation === scope.operation && action.path === path && action.version === scope.version
        && action.contentDigest === scope.contentDigest,
      readRules: () => ({ version: scope.ruleVersion, rules: [{ id: scope.ruleId, personId: actor.personId,
        botId: actor.botId, roomId: actor.roomId, directory: root, grant: 'write', effect: 'allow', purpose: 'Update the fixture note',
      }] }),
      adjudicate: ({ rule }) => ({ verdict: 'allow', ruleId: rule.id, ruleVersion: rule.version, reason: 'Fixture approval' }),
      writeAudit: event => { if (event.type === 'file-effect') outcomes.push(event) },
    })
    const input = { operation: scope.operation, path, version, content }
    assert.deepEqual(await client.reserve(scope), { issued: true, status: 'reserved' })
    assert.equal(await runtime.revoke(actor.personId), 'pending')
    await assert.rejects(client.reserve({ ...scope, dispatchId: 'fresh' }), refused)
    await assert.rejects(client.settle(scope, proof.status, proof.evidenceId), refused)
    permit = true
    await assert.rejects(dispatch(actor, { ...input, content: Buffer.from('wrong bytes') }), { code: 'not-authorized' })
    assert.equal(readFileSync(path, 'utf8'), 'initial')
    assert.deepEqual(await dispatch(actor, input), { operation: 'modify' })
    permit = false
    assert.deepEqual(readFileSync(path), content)
    assert.deepEqual(await client.reserve(scope), { issued: false, status: 'reserved' })
    assert.equal(await runtime.revoke(actor.personId), 'pending')

    stallIdentity = true
    const shortClient = createFileReservationTlsClient({ origin: runtime.origin, ...tls.worker, timeoutMs: 500 })
    const timed = assert.rejects(shortClient.settle(scope, proof.status, proof.evidenceId), unknown)
    await entered.promise
    await timed
    assert.equal(await runtime.revoke(actor.personId), 'pending')
    await runtime.close()
    stalled.resolve()
    await assert.rejects(client.settle(scope, proof.status, proof.evidenceId), unknown)

    stallIdentity = false
    const reopened = await start(false)
    assert.equal(await reopened.runtime.revoke(actor.personId), 'pending')
    await assert.rejects(reopened.client.settle(scope, proof.status, proof.evidenceId), refused)
    // The fixture producer observes the local effect and checks the resulting bytes.
    assert.deepEqual(outcomes, [{ ...actor, type: 'file-effect', operation: scope.operation,
      ruleId: scope.ruleId, ruleVersion: scope.ruleVersion, verdict: 'allowed', outcome: 'completed',
    }])
    assert.equal(digest(readFileSync(path)), scope.contentDigest)
    assert.notEqual(guard.inspectVersion(path), version)
    assert.deepEqual(await reopened.runtime.ingest(trustedProducer, proof), { inserted: true })
    await assert.rejects(reopened.client.settle({ ...scope, targetId: 'other' }, proof.status, proof.evidenceId), refused)
    assert.deepEqual(await reopened.client.settle(scope, proof.status, proof.evidenceId), { revocation: 'revoked' })
    assert.deepEqual(await reopened.client.reserve(scope), { issued: false, status: 'completed' })
    await assert.rejects(dispatch(actor, input), { code: 'not-authorized' })
    assert.equal(outcomes.length, 1)
    assert.deepEqual(readFileSync(path), content)
  })

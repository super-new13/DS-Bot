import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  async *stream() {
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

test('admin configuration starts an isolated model worker and closes it on profile disposal', { timeout: 8000 }, async t => {
  const { profile, tls, scope, config } = fixture(t)
  const ready = Promise.withResolvers()
  const bootstrap = createWorkerBootstrap({ config, adapter: new MockModel(), onReady: ready.resolve })
  config.peerGrants[0].actions.push('cancel')
  await profile.plugin(bootstrap)
  const { origin } = await ready.promise
  assert.equal(profile.get('agents'), undefined)
  assert.equal(profile.get('connection'), undefined)
  const transport = createWorkerTlsTransport({ ...tls.controller, origin })
  const client = createWorkerClient({ origin, nodeId: scope.nodeId, transport })
  await assert.rejects(client.create({ ...scope, botId: 'other' }), { code: 'worker-refused', status: 403 })
  const owned = { ...scope, ...await client.create(scope) }
  const events = []
  const receipt = await client.submit(owned, 'bootstrap-request', 'mock input', { onEvent: event => events.push(event) })
  assert.equal(receipt.status, 'completed')
  assert.deepEqual(events.map(event => event.text), ['mock reply', 'mock reply'])
  assert.deepEqual(await client.status(owned, 'bootstrap-request'), receipt)
  await assert.rejects(client.cancel(owned, 'bootstrap-request'), { code: 'worker-refused', status: 403 })
  await profile.fiber.dispose()
  await assert.rejects(transport(new Request(origin + '/internal/enterprise/worker/status', {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...owned, requestId: 'bootstrap-request' }),
  })), { code: 'ECONNREFUSED' })
})

test('invalid grants and missing certificate files fail before receipt initialization', async t => {
  const { profile, config } = fixture(t)
  const adapter = new MockModel()
  const grant = config.peerGrants[0]
  assert.throws(() => createWorkerBootstrap({ config: { ...config, peerGrants: [{ ...grant, actions: ['anything'] }] }, adapter }), /Invalid administrator/)
  assert.throws(() => createWorkerBootstrap({ config: { ...config, peerGrants: [{ ...grant, fingerprint: '*' }] }, adapter }), /Invalid administrator/)
  assert.throws(() => createWorkerBootstrap({ config: { ...config, certPaths: { ...config.certPaths, key: 'relative.key' } }, adapter }), /Invalid administrator/)
  const bootstrap = createWorkerBootstrap({ config: { ...config, certPaths: { ...config.certPaths, key: config.receiptPath + '.missing' } },
    adapter, onReady: () => assert.fail('unexpected readiness'),
  })
  await assert.rejects(bootstrap.apply(profile), { code: 'ENOENT' })
  assert.throws(() => readFileSync(config.receiptPath), { code: 'ENOENT' })
})

class FileModel extends MockModel {
  steps = 0
  toolResults = []

  async *stream({ messages }) {
    if (this.steps++ !== 0) {
      this.toolResults.push(...messages.filter(message => message.role === 'tool'))
      yield* super.stream()
      return
    }
    const name = 'worker_replace_file'
    const id = 'bootstrap-file-call'
    yield { type: 'block-start', index: 0, blockType: 'tool-call', id, name }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify({ content: 'updated' }) } }
    yield { type: 'finish', reason: { kind: 'tool-use' } }
  }
}

for (const mode of ['disabled by default', 'explicitly enabled', 'fresh permit', 'lost permit', 'replayed permit', 'cancelled permit', 'observer failure']) {
  test('bootstrap guarded file replacement ' + mode,
    { timeout: 8000, skip: process.platform === 'win32' }, async t => {
      const enabled = mode !== 'disabled by default'
      const needsPermit = mode.endsWith('permit') || mode === 'observer failure'
      const writes = ['explicitly enabled', 'fresh permit', 'observer failure'].includes(mode)
      const { profile, tls, scope, config } = fixture(t)
      const root = join(realpathSync(join(config.receiptPath, '..')), 'owned')
      mkdirSync(root, { mode: 0o700 })
      const path = join(root, 'note')
      writeFileSync(path, 'initial')
      if (mode === 'cancelled permit') config.peerGrants[0].actions.push('cancel')
      const ready = Promise.withResolvers()
      const judgments = []
      const reservations = []
      const completions = []
      const waiting = Promise.withResolvers()
      const release = Promise.withResolvers()
      t.after(() => release.resolve())
      const permit = { nodeId: scope.nodeId, targetId: 'fixed-note', path, client: {
        async reserve(proposed, { signal }) {
          reservations.push({ proposed, signal })
          if (mode === 'lost permit') throw Object.assign(new Error('Fixture response lost'), { code: 'reservation-outcome-unknown' })
          if (mode === 'cancelled permit') {
            waiting.resolve()
            await release.promise
          }
          return { issued: mode !== 'replayed permit', status: 'reserved' }
        },
      } }
      const fileTools = {
        root, path, workerOwned: true, maxBytes: 64, ...(needsPermit && { permit,
          onCompleted(event) {
            completions.push({ event, bytes: readFileSync(path, 'utf8') })
            if (mode === 'observer failure') throw new Error('Fixture recording failed')
          },
        }),
        readRules: () => ({ version: 'v1', rules: [{ id: 'note', personId: scope.personId, botId: scope.botId, roomId: null,
          directory: root, grant: 'write', effect: 'allow', purpose: 'Update fixture note',
        }] }),
        isAuthorized: action => action.personId === scope.personId && action.requestId === 'replace-note',
        adjudicate({ rule }) {
          judgments.push(rule.id)
          return { verdict: 'allow', ruleId: rule.id, ruleVersion: rule.version, reason: 'Fixture permits replacement' }
        },
      }
      const auditFile = join(root, 'audit.json')
      const audited = { ...config, auditFile }
      const adapter = new FileModel()
      assert.throws(() => createWorkerBootstrap({ config: audited, adapter }), /Invalid administrator/)
      assert.throws(() => createWorkerBootstrap({ config: { ...audited, auditFile: 'relative.json' }, adapter, fileTools }), /Invalid administrator/)
      assert.throws(() => createWorkerBootstrap({ config: audited, adapter, fileTools: { ...fileTools, writeAudit() {} } }), /Invalid administrator/)
      if (needsPermit) {
        assert.throws(() => createWorkerBootstrap({ config, adapter, fileTools: { ...fileTools, permit: undefined } }), /Invalid administrator/)
        assert.throws(() => createWorkerBootstrap({ config, adapter, fileTools: { ...fileTools, onCompleted: true } }), /Invalid administrator/)
        for (const mismatch of [{ nodeId: 'other' }, { path: join(root, 'other') }, { targetId: '../other' }]) {
          assert.throws(() => createWorkerBootstrap({ config, adapter, fileTools: { ...fileTools, permit: { ...permit, ...mismatch } } }), /Invalid administrator/)
        }
      }
      if (mode === 'explicitly enabled') {
        const corrupt = join(root, 'corrupt.json')
        writeFileSync(corrupt, '{invalid', { mode: 0o600 })
        await assert.rejects(createWorkerBootstrap({ config: { ...audited, auditFile: corrupt }, adapter, fileTools }).apply(profile),
          { code: 'invalid-file-audit' })
        assert.equal(readFileSync(corrupt, 'utf8'), '{invalid')
        await assert.rejects(createWorkerBootstrap({ config: { ...audited, auditFile: path }, adapter, fileTools }).apply(profile), /Invalid administrator/)
        assert.throws(() => readFileSync(config.receiptPath), { code: 'ENOENT' })
        const failed = createWorkerBootstrap({ config: audited, adapter, fileTools, onReady() { throw new Error('fixture failed after activation') } })
        await assert.rejects(failed.apply(profile), /fixture failed after activation/)
      }
      assert.throws(() => createWorkerBootstrap({ config: { ...config, fileTools: {} }, adapter }), /Invalid administrator/)
      assert.throws(() => createWorkerBootstrap({ config, adapter, fileTools: { ...fileTools, isAuthorized: true } }), /Invalid administrator/)
      assert.throws(() => createWorkerBootstrap({ config, adapter, fileTools: { ...fileTools, path: config.receiptPath } }), /Invalid administrator/)
      assert.throws(() => createWorkerBootstrap({ config, adapter, fileTools: { ...fileTools, maxBytes: 0 } }), /Invalid administrator/)
      const trusted = { ...fileTools }
      const bootstrap = createWorkerBootstrap({ config: enabled ? audited : config, adapter,
        onReady: ready.resolve, ...(enabled && { fileTools }),
      })
      fileTools.path = join(root, 'other')
      fileTools.onCompleted = () => assert.fail('replacement observer called')
      permit.targetId = 'changed-after-bootstrap'
      permit.client.reserve = () => assert.fail('replacement client called')
      await profile.plugin(bootstrap)
      const { origin } = await ready.promise
      const client = createWorkerClient({ origin, nodeId: scope.nodeId, transport: createWorkerTlsTransport({ ...tls.controller, origin }) })
      const owned = { ...scope, ...await client.create(scope) }
      const submitted = client.submit(owned, 'replace-note', 'Attempt fixture update')
      if (mode === 'cancelled permit') {
        await waiting.promise
        const { signal } = reservations[0]
        const aborted = signal.aborted ? Promise.resolve() : new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
        assert.deepEqual(await client.cancel(owned, 'replace-note'), { accepted: true })
        await aborted
        release.resolve()
      }
      const result = await submitted
      assert.equal(result.status, mode === 'cancelled permit' ? 'aborted' : 'completed')
      assert.equal(readFileSync(path, 'utf8'), writes ? 'updated' : 'initial')
      assert.deepEqual(judgments, enabled ? ['note'] : [])
      if (needsPermit) {
        assert.equal(reservations.length, 1)
        const { proposed, signal } = reservations[0]
        assert.ok(signal instanceof AbortSignal)
        assert.equal(signal.aborted, mode === 'cancelled permit')
        assert.equal(proposed.nodeId, scope.nodeId)
        assert.equal(proposed.sessionId, owned.sessionId)
        assert.equal(proposed.targetId, 'fixed-note')
        assert.equal(proposed.requestId, 'replace-note')
        if (writes) {
          assert.deepEqual(completions, [{ event: { scope: proposed, status: 'completed' }, bytes: 'updated' }])
          assert.equal(completions[0].event.scope, proposed)
          assert.ok(Object.isFrozen(proposed) && Object.isFrozen(completions[0].event))
          assert.deepEqual(proposed, { ...scope, sessionId: owned.sessionId, roomId: null, requestId: 'replace-note',
            dispatchId: 'bootstrap-file-call', targetId: 'fixed-note', operation: 'modify', version: proposed.version,
            contentDigest: createHash('sha256').update('updated').digest('hex'), ruleId: 'note', ruleVersion: 'v1',
          })
          assert.ok(proposed.version)
        } else assert.deepEqual(completions, [])
        if (mode === 'observer failure') {
          assert.deepEqual(adapter.toolResults.at(-1)?.content, [{ type: 'text', text: 'File updated (evidence incomplete)' }])
          assert.equal(adapter.toolResults.at(-1)?.isError === true, false)
          const repeated = await client.submit(owned, 'replace-note', 'Attempt fixture update')
          assert.equal(repeated.status, 'completed')
          assert.equal(completions.length, 1)
          assert.equal(reservations.length, 1)
        }
        const { events } = JSON.parse(readFileSync(auditFile, 'utf8'))
        assert.deepEqual(events.map(event => event.type), writes ? ['file-authorization', 'file-effect'] : ['file-authorization'])
        return
      }
      if (!enabled) {
        assert.throws(() => readFileSync(auditFile), { code: 'ENOENT' })
        return
      }
      const before = JSON.parse(readFileSync(auditFile, 'utf8'))
      assert.deepEqual(before.events.map(({ type, outcome }) => [type, outcome]), [
        ['file-authorization', undefined], ['file-effect', 'completed'],
      ])
      await profile.fiber.dispose()
      const restarted = new Context()
      t.after(() => restarted.fiber.dispose())
      const nextReady = Promise.withResolvers()
      await restarted.plugin(createWorkerBootstrap({ config: { ...audited, initialize: false }, adapter: new FileModel(),
        fileTools: { ...trusted, isAuthorized: action => action.requestId === 'replace-again' }, onReady: nextReady.resolve,
      }))
      const next = await nextReady.promise
      const nextClient = createWorkerClient({ origin: next.origin, nodeId: scope.nodeId,
        transport: createWorkerTlsTransport({ ...tls.controller, origin: next.origin }),
      })
      const nextScope = { ...scope, ...await nextClient.create(scope) }
      assert.equal((await nextClient.submit(nextScope, 'replace-again', 'Run another authorized update')).status, 'completed')
      await restarted.fiber.dispose()
      const after = JSON.parse(readFileSync(auditFile, 'utf8'))
      assert.deepEqual(after.events.slice(0, 2), before.events)
      assert.deepEqual(after.events.slice(2).map(({ requestId, verdict }) => [requestId, verdict]), [
        ['replace-again', 'allowed'], ['replace-again', 'allowed'],
      ])
    })
}

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { createWorkerClient } from '../src/host/enterprise/worker-client.js'
import { startLocalWorkerRuntime } from '../src/host/enterprise/worker-runtime.js'
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

const name = 'worker_replace_file'

for (const mode of ['disabled', 'allowed', 'foreign actor', 'revoked', 'wrong call', 'foreign tool', 'nested']) {
  test('guarded worker runtime file tool ' + mode, { timeout: 8000, skip: process.platform === 'win32' }, async t => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'worker-file-runtime-'))
    const ctx = new Context()
    let runtime
    const decision = Promise.withResolvers()
    t.after(async () => {
      decision.resolve()
      try { if (runtime) await runtime.close(); else await ctx.fiber.dispose() }
      finally { rmSync(root, { recursive: true, force: true }) }
    })
    const path = join(root, 'note')
    writeFileSync(path, 'initial')
    const tls = makeTls(root)
    await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
    let step = 0
    let foreignInvoked = false
    if (mode === 'foreign tool' || mode === 'disabled') {
      ctx.tools.register({ name: 'foreign_tool', description: 'Fixture sentinel', parameters: {},
        output: { schema: { type: 'string' }, render: () => [] },
        async execute() { foreignInvoked = true; return 'sentinel' },
      })
    }
    if (mode === 'wrong call' || mode === 'nested') {
      ctx.on('tools/execute', (exec, next) => {
        if (mode === 'wrong call') exec.callId = 'changed-call'
        else exec.parent = Symbol('nested-fixture')
        return next()
      }, { prepend: mode === 'nested' })
    }
    class MockModel extends LlmAdapter {
      providerInfo() { return { id: 'mock', name: 'Mock' } }
      async resolveModel(provider, id) {
        return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } }
      }
      async *stream() {
        if (step++ > 0) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
        const tool = mode === 'disabled' || mode === 'foreign tool' ? 'foreign_tool' : name
        const args = tool === name ? { content: 'approved' } : {}
        yield { type: 'block-start', index: 0, blockType: 'tool-call', id: 'fixture-call', name: tool }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'fixture-call', name: tool, arguments: JSON.stringify(args) } }
        yield { type: 'finish', reason: { kind: 'tool-use' } }
      }
    }
    ctx.llm.registerAdapter(['mock'], new MockModel())
    await mountAgentLoopTestHarness(ctx)
    const scope = { nodeId: 'node', botId: 'helper', personId: mode === 'foreign actor' ? 'bob' : 'alice' }
    const fingerprint = new X509Certificate(tls.controller.cert).fingerprint256
    const judging = Promise.withResolvers()
    let judgments = 0
    let live = true
    runtime = await startLocalWorkerRuntime({ ctx, nodeId: scope.nodeId, provider: 'mock', model: 'mock', tls: tls.server,
      receiptPath: join(root, 'receipts.json'), initialize: true,
      authorizePeer: peer => peer === fingerprint, authorizeSession: () => live,
      ...(mode !== 'disabled' && { fileTools: { root, path, workerOwned: true,
        readRules: () => ({ version: 'v1', rules: [{ id: 'note', personId: 'alice', botId: 'helper', roomId: null,
          directory: root, grant: 'write', effect: 'allow', purpose: 'Update fixture note',
        }] }),
        isAuthorized: action => action.personId === 'alice' && action.requestId === 'fixture-request',
        async adjudicate({ rule }) {
          judgments++
          if (mode === 'revoked') { judging.resolve(); await decision.promise }
          return { verdict: 'allow', ruleId: rule.id, ruleVersion: rule.version, reason: 'Fixture allows replacement' }
        },
      } }),
    })
    const origin = runtime.origin
    const client = createWorkerClient({ origin, nodeId: scope.nodeId, transport: createWorkerTlsTransport({ ...tls.controller, origin }) })
    const { sessionId } = await client.create(scope)
    const submission = client.submit({ ...scope, sessionId }, 'fixture-request', 'update fixture')
    if (mode === 'revoked') {
      await judging.promise
      assert.equal(readFileSync(path, 'utf8'), 'initial')
      live = false
      decision.resolve()
    }
    await submission
    assert.equal(readFileSync(path, 'utf8'), mode === 'allowed' ? 'approved' : 'initial')
    assert.equal(judgments, ['allowed', 'revoked'].includes(mode) ? 1 : 0)
    assert.equal(foreignInvoked, false)
    const results = ctx.agents.get(sessionId).session.snapshotEvents().filter(event => event.type === 'tool/result')
    assert.equal(results.length, 1)
    assert.equal(results[0].data.message.isError === true, mode !== 'allowed')
  })
}

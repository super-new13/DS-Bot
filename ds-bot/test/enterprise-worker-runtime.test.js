import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

async function mockContext(calls) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  class Model extends LlmAdapter {
    providerInfo() { return { id: 'mock', name: 'Mock' } }
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 }, defaultMaxTokens: 1000 }
    }
    async *stream({ messages, signal }) {
      const prompt = messages.findLast(message => message.role === 'user').content[0].text
      calls.push(prompt)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'mock reply' }
      if (prompt === 'held') {
        const hold = Promise.withResolvers()
        const listener = addAbortListener(signal, hold.resolve)
        try { await hold.promise } finally { listener[Symbol.dispose]() }
        signal.throwIfAborted()
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'mock reply' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new Model())
  await mountAgentLoopTestHarness(ctx)
  return ctx
}

test('worker runtime streams real mock DSH turns and preserves scoped receipts across restart', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-worker-runtime-'))
  let current
  t.after(async () => {
    try { await current?.close() } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  const tls = makeTls(dir)
  const fingerprint = new X509Certificate(tls.controller.cert).fingerprint256
  const calls = []
  const scope = { nodeId: 'mock-node', personId: 'employee', botId: 'helper' }
  const matches = target => Object.keys(scope).every(key => scope[key] === target[key])
  async function start(initialize) {
    const ctx = await mockContext(calls)
    current = await startLocalWorkerRuntime({ ctx, ...scope, provider: 'mock', model: 'model', initialize,
      receiptPath: join(dir, 'receipts.json'), tls: tls.server,
      authorizeSession: matches,
      authorizePeer: (identity, { scope: target }) => identity === fingerprint && matches(target),
    })
    const transport = createWorkerTlsTransport({ ...tls.controller, origin: current.origin })
    return createWorkerClient({ origin: current.origin, nodeId: scope.nodeId, transport })
  }
  const client = await start(true)
  await assert.rejects(client.create({ ...scope, personId: 'other' }), { code: 'worker-refused', status: 403 })
  const owned = { ...scope, ...await client.create(scope) }
  const streamed = []
  const receipt = await client.submit(owned, 'complete', 'finish', { onEvent: event => streamed.push(event) })
  assert.equal(receipt.status, 'completed')
  assert.deepEqual(streamed, ['delta', 'reply'].map(type => ({ type, text: 'mock reply', requestId: 'complete' })))
  assert.deepEqual(await client.status(owned, 'complete'), receipt)

  const first = Promise.withResolvers()
  const interrupted = client.submit(owned, 'interrupt', 'held', { onEvent: first.resolve })
  assert.equal((await first.promise).type, 'delta')
  assert.equal((await client.status(owned, 'interrupt')).status, 'admitted')
  const close = current.close()
  assert.equal(current.close(), close)
  await close
  assert.equal((await interrupted).status, 'unknown')

  const restarted = await start(false)
  assert.deepEqual(await restarted.status(owned, 'complete'), receipt)
  const unknown = await restarted.status(owned, 'interrupt')
  assert.equal(unknown.status, 'unknown')
  assert.deepEqual(await restarted.submit(owned, 'interrupt', 'held'), unknown)
  assert.deepEqual(await restarted.status({ ...owned, sessionId: 'other-session' }, 'complete'), { requestId: 'complete', status: 'unknown' })
  assert.deepEqual(calls, ['finish', 'held'])
})

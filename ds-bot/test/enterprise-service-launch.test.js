import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
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
const packageDir = new URL('../', import.meta.url)
const scope = { nodeId: 'node', personId: 'alice', botId: 'helper' }
const marker = 'fixture-diagnostic-must-stay-private'
const failure = 'Enterprise node could not start. Check service configuration and file permissions.'

function start(t, executable, dir, role, path, env) {
  const child = spawn(process.execPath, [executable, role, '--config', path], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  })
  const lines = createInterface({ input: child.stdout })
  const initial = once(lines, 'line', { signal: AbortSignal.timeout(5000) }).then(([line]) => JSON.parse(line))
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  return {
    ready: () => Promise.race([initial, closed.then(() => { throw new Error('Launcher exited before readiness') })]),
    async close(signal) {
      assert.equal(child.kill(signal), true)
      assert.deepEqual(await closed, [0, null])
      assert.equal(stderr, '')
    },
  }
}

test('packaged policy and worker launchers serve mock fixtures and handle shutdown signals',
  { timeout: 30000, skip: process.platform === 'win32' }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'dsbot-service-launch-'))
    t.after(() => rm(dir, { recursive: true, force: true }))
    const archive = execFileSync('npm', ['pack', '--offline', '--ignore-scripts', '--silent', '--pack-destination', dir],
      { cwd: packageDir, encoding: 'utf8', timeout: 10000 }).trim()
    execFileSync('tar', ['-xzf', join(dir, archive), '-C', dir], { timeout: 5000 })
    const executable = join(dir, 'package', 'bin', 'ds-bot-enterprise-node.mjs')
    const harness = resolve(process.env.DSH_HARNESS ?? fileURLToPath(new URL('../dev/harness/', import.meta.url)))
    // Give the extracted package and operator modules the normal installed peer layout.
    await mkdir(join(dir, 'node_modules'))
    await symlink(join(harness, 'node_modules', '@deepseek-ai'), join(dir, 'node_modules', '@deepseek-ai'))
    const tls = makeTls(dir)
    const controller = new X509Certificate(tls.controller.cert).fingerprint256
    const producer = new X509Certificate(tls.producer.cert).fingerprint256
    const env = { DSH_HOME: join(dir, 'fixture-home'), DSH_TELEMETRY_DISABLED: '1' }
    const config = name => join(dir, name + '.mjs')
    const prelude = "import { readFileSync } from 'node:fs'; import { join } from 'node:path'; const file = name => join(import.meta.dirname, name);"
    const policy = config('policy')
    const worker = config('worker')
    await writeFile(policy, prelude + [
      "const tls = { ca: readFileSync(file('ca.pem')), cert: readFileSync(file('server.pem')), key: readFileSync(file('server.key')) };",
      "export default { initialize: true, reservationFile: file('reservations.json'), evidenceFile: file('evidence.json'),",
      "listener: { tls }, workerGrants: " + JSON.stringify([{ fingerprint: controller, nodeId: scope.nodeId }]) + ',',
      "evidenceListener: { tls, producerGrants: " + JSON.stringify([{ fingerprint: producer, nodeId: scope.nodeId }]) + ' },',
      "authorizeScope: (_node, _action, input) => input.personId === 'alice', canReserve: () => true };",
    ].join(' '))
    await writeFile(worker, prelude + [
      "import { LlmAdapter } from '@deepseek-ai/dsh-llm'; class Mock extends LlmAdapter {",
      "providerInfo() { return { id: 'mock', name: 'Mock' } }",
      "async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 } } }",
      "async *stream() { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'fixture reply' };",
      "yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture reply' } }; yield { type: 'finish', reason: { kind: 'stop' } } } }",
      "export default { adapter: new Mock(), config: { nodeId: 'node', provider: 'mock', model: 'model', initialize: true, receiptPath: file('receipts.json'),",
      "certPaths: { ca: file('ca.pem'), cert: file('server.pem'), key: file('server.key') }, peerGrants: " + JSON.stringify([{
        fingerprint: controller, personId: scope.personId, botId: scope.botId, actions: ['create', 'submit', 'status'],
      }]) + ' } };',
    ].join(' '))

    const run = (role, file) => spawnSync(process.execPath, [executable, role, '--config', file], { cwd: dir, env, encoding: 'utf8', timeout: 5000 })
    const bad = config('bad')
    await writeFile(bad, 'throw new Error(' + JSON.stringify(marker) + ')')
    for (const role of ['policy', 'worker']) {
      const result = run(role, bad)
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr.trim(), failure)
    }
    assert.equal(run('worker', 'relative.mjs').status, 2)

    await t.test('policy with SIGTERM', async st => {
      const process = start(st, executable, dir, 'policy', policy, env)
      const { role, origin, evidenceOrigin, ...extra } = await process.ready()
      assert.equal(role, 'policy')
      assert.deepEqual(extra, {})
      assert.match(evidenceOrigin, /^https:/)
      const client = createFileReservationTlsClient({ origin, ...tls.controller })
      const proposed = { ...scope, roomId: null, sessionId: 'session', requestId: 'request', dispatchId: 'call', operation: 'read',
        targetId: 'note', version: 'prior', contentDigest: null, ruleId: 'rule', ruleVersion: 'v1',
      }
      assert.deepEqual(await client.reserve(proposed), { issued: true, status: 'reserved' })
      await process.close('SIGTERM')
      await assert.rejects(client.reserve(proposed), { code: 'reservation-outcome-unknown' })
    })
    await t.test('worker with SIGINT', async st => {
      const process = start(st, executable, dir, 'worker', worker, env)
      const { role, origin, ...extra } = await process.ready()
      assert.equal(role, 'worker')
      assert.deepEqual(extra, {})
      const client = createWorkerClient({ origin, nodeId: scope.nodeId, transport: createWorkerTlsTransport({ origin, ...tls.controller }) })
      const owned = { ...scope, ...await client.create(scope) }
      const events = []
      assert.equal((await client.submit(owned, 'fixture-request', 'Reply in the test', { onEvent: event => events.push(event) })).status, 'completed')
      assert.equal(events.find(event => event.type === 'reply')?.text, 'fixture reply')
      await process.close('SIGINT')
      assert.equal((await client.status(owned, 'fixture-request')).status, 'unknown')
    })
  })

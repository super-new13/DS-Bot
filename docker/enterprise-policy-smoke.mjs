// Disposable Compose fixture. Copies named policy.mjs and worker.mjs are
// imported by the packaged launcher. Direct invocations run fixture probes.
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { request } from 'node:https'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const role = basename(fileURLToPath(import.meta.url), '.mjs')
const config = name => fileURLToPath(new URL(name, import.meta.url))
const stateRoot = join(process.cwd(), 'smoke-state')
const state = name => join(stateRoot, name)
const load = name => import(new URL('../node_modules/ds-bot/src/host/enterprise/' + name + '.js', import.meta.url))
const tls = name => ({ ca: readFileSync(config('ca.pem')), cert: readFileSync(config(name + '.pem')), key: readFileSync(config(name + '.key')) })
const fingerprint = name => new X509Certificate(readFileSync(config(name + '.pem'))).fingerprint256
const reservationOrigin = 'https://file-policy:9443'
const evidenceOrigin = 'https://file-policy:9444'
const workerOrigin = 'https://worker:9445'
const host = '0.0.0.0'
const scope = { nodeId: 'node', personId: 'alice', botId: 'helper' }
const requestId = 'fixture-request'
const validEmployeeRequest = id => typeof id === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
const observedRequest = process.argv[3] ?? requestId
const owns = target => Object.entries(scope).every(([key, value]) => target[key] === value) && target.roomId === null
const root = state('owned')
const path = join(root, 'note')
const readyFile = state('fixture-ready')
const entries = name => JSON.parse(readFileSync(state(name), 'utf8')).entries

// Operations remain local to the fixture role's volume and are never served
// over a listener. Atomic response publication avoids partial reads by exec.
function announce(commands) {
  let running = false
  setInterval(async () => {
    const command = state('fixture-command')
    if (running || !existsSync(command)) return
    running = true
    try {
      const name = readFileSync(command, 'utf8')
      unlinkSync(command)
      const result = Object.hasOwn(commands, name) ? { value: await commands[name]() } : { failed: true }
      writeFileSync(state('fixture-response.tmp'), JSON.stringify(result))
      renameSync(state('fixture-response.tmp'), state('fixture-response'))
    } catch {
      process.exitCode = 1
      process.kill(process.pid, 'SIGTERM')
    } finally { running = false }
  }, 50).unref()
  writeFileSync(readyFile, 'ready')
}

async function command(name) {
  const response = state('fixture-response')
  assert.equal(existsSync(response), false)
  writeFileSync(state('fixture-command.tmp'), name, { flag: 'wx' })
  renameSync(state('fixture-command.tmp'), state('fixture-command'))
  for (let i = 0; i < 150; i++) {
    if (existsSync(response)) {
      const result = JSON.parse(readFileSync(response, 'utf8'))
      unlinkSync(response)
      assert.equal(result.failed, undefined)
      return result.value
    }
    await delay(100)
  }
  throw new Error('Fixture operation did not acknowledge: ' + name)
}

async function policyOptions() {
  return {
    reservationFile: state('reservations.json'), evidenceFile: state('evidence.json'), initialize: true,
    listener: { tls: tls('policy'), host, port: 9443, origin: reservationOrigin },
    workerGrants: [{ fingerprint: fingerprint('reservation-client'), nodeId: scope.nodeId }],
    evidenceListener: { tls: tls('policy'), host, port: 9444, origin: evidenceOrigin,
      producerGrants: [{ fingerprint: fingerprint('producer'), nodeId: scope.nodeId }] },
    authorizeScope: (node, _action, target) => node === scope.nodeId && owns(target),
    canReserve: target => owns(target) && target.targetId === 'note' && target.ruleId === 'edit' && target.ruleVersion === 'v1',
    onReady: ({ revoke }) => announce({ revoke: () => revoke(scope.personId) }),
  }
}

async function reservationClient() {
  const { createFileReservationTlsClient } = await load('file-reservation-tls')
  return createFileReservationTlsClient({ origin: reservationOrigin, ...tls('reservation-client') })
}

async function workerOptions() {
  const { LlmAdapter } = await import('@deepseek-ai/dsh-llm')
  class MockModel extends LlmAdapter {
    used = false
    providerInfo() { return { id: 'mock', name: 'Mock' } }
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 }, defaultMaxTokens: 1000 }
    }
    async *stream() {
      if (this.used) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
      this.used = true
      const name = 'worker_replace_file'
      const id = 'fixture-call'
      yield { type: 'block-start', index: 0, blockType: 'tool-call', id, name }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify({ content: 'updated' }) } }
      yield { type: 'finish', reason: { kind: 'tool-use' } }
    }
  }
  mkdirSync(root, { mode: 0o700 })
  writeFileSync(path, 'initial', { flag: 'wx', mode: 0o600 })
  const reservations = await reservationClient()
  const { createFileEvidenceTlsClient } = await load('file-evidence-tls')
  const { createFileSettlementDelivery } = await load('file-settlement-delivery')
  return {
    adapter: new MockModel(),
    config: { nodeId: scope.nodeId, provider: 'mock', model: 'model', host, port: 9445, origin: workerOrigin, initialize: true,
      receiptPath: state('receipts.json'), outboxFile: state('outbox.json'),
      certPaths: { ca: config('ca.pem'), cert: config('worker-server.pem'), key: config('worker-server.key') },
      peerGrants: [{ fingerprint: fingerprint('controller'), personId: scope.personId, botId: scope.botId, actions: ['create', 'submit'] }],
    },
    fileTools: { root, path, workerOwned: true, isAuthorized: target => process.env.DSBOT_SMOKE_EMPLOYEE === '1'
      ? validEmployeeRequest(target.requestId) : target.requestId === requestId,
      permit: { nodeId: scope.nodeId, targetId: 'note', path, client: reservations },
      readRules: () => ({ version: 'v1', rules: [{ id: 'edit', personId: scope.personId, botId: scope.botId, roomId: null,
        directory: root, grant: 'write', effect: 'allow', purpose: 'Update the fixture note',
      }] }),
      adjudicate: ({ rule }) => ({ verdict: 'allow', ruleId: rule.id, ruleVersion: rule.version, reason: 'Fixture approval' }),
    },
    ingestEvidence: createFileSettlementDelivery({ reservations, ingest: createFileEvidenceTlsClient({ origin: evidenceOrigin, ...tls('producer') }) }),
    onReady: ({ drainEvidence }) => announce({ drain: () => drainEvidence({ limit: 1 }) }),
  }
}

async function submit() {
  const { createWorkerClient } = await load('worker-client')
  const { createWorkerTlsTransport } = await load('worker-tls')
  const client = createWorkerClient({ origin: workerOrigin, nodeId: scope.nodeId,
    transport: createWorkerTlsTransport({ origin: workerOrigin, ...tls('controller') }) })
  await assert.rejects(client.create({ ...scope, personId: 'foreign' }), { code: 'worker-refused' })
  const owned = { ...scope, ...await client.create(scope) }
  const receipt = await client.submit(owned, requestId, 'Update the fixture note')
  assert.equal(receipt.status, 'completed')
}

async function verifyWorker(phase) {
  assert.equal(readFileSync(path, 'utf8'), 'updated')
  if (phase === 'verify-write') {
    const outbox = entries('outbox.json')
    assert.equal(outbox.length, 1)
    const [proof] = outbox
    assert.equal(proof.scope.requestId, observedRequest)
    assert.ok(owns(proof.scope))
    const { createFileEvidenceTlsClient } = await load('file-evidence-tls')
    const ordinary = createFileEvidenceTlsClient({ origin: evidenceOrigin, ...tls('reservation-client') })
    await assert.rejects(ordinary(proof), { code: 'evidence-refused' })
    writeFileSync(state('fixture-proof'), JSON.stringify(proof), { flag: 'wx' })
  } else {
    const proof = JSON.parse(readFileSync(state('fixture-proof'), 'utf8'))
    const reservations = await reservationClient()
    if (phase === 'verify-pending') {
      await assert.rejects(reservations.reserve({ ...proof.scope, requestId: 'fresh' }), { code: 'reservation-refused' })
      await assert.rejects(reservations.settle(proof.scope, proof.status, proof.evidenceId), { code: 'reservation-refused' })
    } else {
      assert.deepEqual(entries('outbox.json'), [])
      assert.deepEqual(await reservations.reserve(proof.scope), { issued: false, status: 'completed' })
    }
  }
}

async function seedInvite() {
  const base = '/opt/dsh-template/profiles/web/node_modules/ds-bot/src/host/enterprise/'
  const { openEmployeeAccountStore } = await import(base + 'account-store.js')
  const { createEmployeeAccounts } = await import(base + 'accounts.js')
  const { accountFile } = JSON.parse(readFileSync(config('config.json'), 'utf8'))
  const store = await openEmployeeAccountStore(accountFile, { initialize: true })
  const result = await createEmployeeAccounts(store).issueInvite(scope.personId)
  if (!result?.token) throw new Error('Fixture invitation could not be provisioned')
  process.stdout.write(result.token + '\n')
}

async function employeeReady() {
  const { https } = JSON.parse(readFileSync(config('config.json'), 'utf8'))
  const origin = new URL(https.origin)
  await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: https.port, path: '/', ca: readFileSync(config('ca.pem')),
      signal: AbortSignal.timeout(2000), headers: { host: origin.host } }, res => {
      res.resume()
      if (res.statusCode === 200) resolve()
      else reject(new Error('Employee fixture is not ready'))
    })
    req.on('error', reject)
    req.end()
  })
}

const action = process.argv[2]
let options
if (role === action && process.argv[3] === '--config') {
  mkdirSync(stateRoot, { mode: 0o700 })
  options = await (role === 'policy' ? policyOptions() : workerOptions())
}
else if (action === 'ready') assert.equal(readFileSync(readyFile, 'utf8'), 'ready')
else if (role === 'employee' && action === 'seed-invite') await seedInvite()
else if (role === 'employee' && action === 'employee-ready') await employeeReady()
else if (role === 'controller' && action === 'submit') await submit()
else if (role === 'policy' && action === 'revoke-pending') assert.equal(await command('revoke'), 'pending')
else if (role === 'policy' && action === 'revoke-complete') {
  assert.equal(await command('revoke'), 'revoked')
  const evidence = entries('evidence.json')
  assert.equal(evidence.length, 1)
  assert.ok(owns(evidence[0].scope))
  assert.equal(evidence[0].scope.requestId, observedRequest)
} else if (role === 'worker' && action === 'drain') assert.deepEqual(await command('drain'), { acknowledged: 1 })
else if (role === 'worker' && ['verify-write', 'verify-pending', 'verify-settled'].includes(action)) await verifyWorker(action)
else throw new Error('Unknown smoke fixture role or operation')

export default options

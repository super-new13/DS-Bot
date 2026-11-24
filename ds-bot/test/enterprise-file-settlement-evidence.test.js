import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openFileSettlementEvidence } from '../src/host/enterprise/file-settlement-evidence.js'
import { createFileReservationHttpHandler } from '../src/host/enterprise/file-reservation-http.js'
import { openFileReservationStore } from '../src/host/enterprise/file-reservation-store.js'
import { createFileReservations } from '../src/host/enterprise/file-reservations.js'

const scope = { nodeId: 'node', personId: 'alice', botId: 'bot', roomId: 'room', sessionId: 'session',
  requestId: 'request', dispatchId: 'call', operation: 'modify', targetId: 'note', version: 'original',
  contentDigest: 'a'.repeat(64), ruleId: 'write', ruleVersion: 'one',
}
const proof = { scope, status: 'completed', evidenceId: 'effect-a' }
const posix = { skip: process.platform === 'win32' }
const conflict = { code: 'settlement-evidence-conflict' }
const invalid = { code: 'invalid-settlement-evidence' }

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsbot-settlement-evidence-'))
  const stores = []
  t.after(async () => {
    try { await Promise.all(stores.map(store => store.close())) }
    finally { await rm(dir, { recursive: true, force: true }) }
  })
  const trustedProducer = Symbol('fixture producer')
  const file = join(dir, 'evidence.json')
  async function open(options) {
    const store = await openFileSettlementEvidence(file, { trustedProducer, ...options })
    stores.push(store)
    return store
  }
  return { dir, file, trustedProducer, open }
}

test('trusted terminal evidence survives reopening and requires an exact match', posix, async t => {
  const { open, trustedProducer } = await fixture(t)
  const first = await open({ initialize: true })
  assert.equal(await first.verifySettlement(scope.nodeId, proof), false)
  await assert.rejects(first.ingest(Symbol('fixture producer'), proof), { code: 'not-authorized' })
  await assert.rejects(first.ingest(trustedProducer, { ...proof, status: 'unknown' }), invalid)
  assert.deepEqual(await first.ingest(trustedProducer, proof), { inserted: true })
  await first.close()
  const { verifySettlement } = await open()
  assert.equal(await verifySettlement(scope.nodeId, proof), true)
  assert.equal(await verifySettlement('foreign', proof), false)
  assert.equal(await verifySettlement(scope.nodeId, { ...proof, evidenceId: 'missing' }), false)
  assert.equal(await verifySettlement(scope.nodeId, { ...proof, status: 'fenced' }), false)
  assert.equal(await verifySettlement(scope.nodeId, proof, { signal: AbortSignal.abort() }), false)
  for (const field of Object.keys(scope)) {
    const other = field === 'contentDigest' ? 'b'.repeat(64) : field === 'operation' ? 'create' : 'changed'
    const changed = { ...scope, [field]: other }
    if (field === 'operation') changed.version = null
    assert.equal(await verifySettlement(scope.nodeId, { ...proof, scope: changed }), false, field)
  }
})

test('duplicate evidence is idempotent and conflicting IDs or dispatches cannot replace it', posix, async t => {
  const { open, trustedProducer } = await fixture(t)
  const store = await open({ initialize: true })
  const results = await Promise.all(Array.from({ length: 5 }, () => store.ingest(trustedProducer, proof)))
  assert.equal(results.filter(result => result.inserted).length, 1)
  await assert.rejects(store.ingest(trustedProducer, { ...proof, status: 'cancelled' }), conflict)
  await assert.rejects(store.ingest(trustedProducer, { ...proof, evidenceId: 'different', status: 'fenced' }), conflict)
  await assert.rejects(store.ingest(trustedProducer, { ...proof, scope: { ...scope, dispatchId: 'different' } }), conflict)
  assert.equal(await store.verifySettlement(scope.nodeId, proof), true)
})

test('worker claims leave revocation pending until the trusted producer records the outcome', posix, async t => {
  const { dir, open, trustedProducer } = await fixture(t)
  const reservationStore = await openFileReservationStore(join(dir, 'reservations.json'), { initialize: true })
  t.after(reservationStore.close)
  const reservations = createFileReservations({ transact: reservationStore.transact, canReserve: () => true })
  await reservations.reserve(scope)
  assert.equal(await reservations.revoke(scope.personId), 'pending')
  const first = await open({ initialize: true })
  await first.close()
  const reopened = await open()
  const origin = 'https://central.example.test'
  const worker = Object.freeze({})
  const handle = createFileReservationHttpHandler({ origin, reservations,
    authenticateWorker: peer => peer === worker ? scope.nodeId : undefined, authorizeScope: () => true,
    verifySettlement: reopened.verifySettlement,
  })
  const settle = () => handle(new Request(origin + '/internal/enterprise/file-reservations/settle', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(proof),
  }), worker)
  assert.equal((await settle()).status, 403)
  assert.equal(await reservations.revoke(scope.personId), 'pending')
  await reopened.ingest(trustedProducer, proof)
  const result = await settle()
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { revocation: 'revoked' })
})

test('corrupt evidence fails verification and is preserved', posix, async t => {
  const { file, open, trustedProducer } = await fixture(t)
  const store = await open({ initialize: true })
  const corrupt = JSON.stringify({ version: 1, entries: [proof, proof] })
  await writeFile(file, corrupt)
  assert.equal(await store.verifySettlement(scope.nodeId, proof), false)
  await assert.rejects(store.ingest(trustedProducer, proof), invalid)
  await store.close()
  await assert.rejects(open({ initialize: true }), invalid)
  assert.equal(await readFile(file, 'utf8'), corrupt)
})

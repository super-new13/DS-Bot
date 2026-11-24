import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openFileEffectOutbox } from '../src/host/enterprise/file-effect-outbox.js'
import { openFileSettlementEvidence } from '../src/host/enterprise/file-settlement-evidence.js'

const scope = { nodeId: 'worker', personId: 'alice', botId: 'helper', roomId: null, sessionId: 'session',
  requestId: 'request', dispatchId: 'call', targetId: 'note', operation: 'modify', version: 'original',
  contentDigest: 'a'.repeat(64), ruleId: 'edit', ruleVersion: 'v1',
}
const completed = { scope, status: 'completed' }
const invalid = { code: 'invalid-effect-outbox' }
const posix = { skip: process.platform === 'win32', timeout: 5000 }

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsbot-effect-outbox-'))
  const stores = []
  t.after(async () => {
    try { await Promise.all(stores.map(store => store.close())) }
    finally { await rm(dir, { recursive: true, force: true }) }
  })
  const file = join(dir, 'outbox.json')
  async function open(options) {
    const store = await openFileEffectOutbox(file, options)
    stores.push(store)
    return store
  }
  return { dir, file, stores, open }
}

test('lost acknowledgment retains the same evidence ID across reopening', posix, async t => {
  const { dir, stores, open } = await fixture(t)
  const first = await open({ initialize: true })
  const producer = Symbol('trusted fixture producer')
  const center = await openFileSettlementEvidence(join(dir, 'center.json'), { trustedProducer: producer, initialize: true })
  stores.push(center)
  const inserts = await Promise.all(Array.from({ length: 4 }, () => first.onCompleted(completed)))
  assert.equal(inserts.filter(entry => entry.inserted).length, 1)
  let delivered
  await assert.rejects(first.drain(async entry => {
    delivered = entry
    assert.deepEqual(await center.ingest(producer, entry), { inserted: true })
    throw new Error('fixture lost acknowledgment')
  }), /fixture lost acknowledgment/)
  await first.close()
  const reopened = await open()
  assert.deepEqual(await reopened.drain(async entry => {
    assert.deepEqual(entry, delivered)
    assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.scope))
    const acknowledgment = await center.ingest(producer, entry)
    assert.deepEqual(acknowledgment, { inserted: false })
    return acknowledgment
  }), { acknowledged: 1 })
  assert.equal(await center.verifySettlement(scope.nodeId, delivered), true)
  assert.deepEqual(await reopened.drain(() => assert.fail('empty outbox delivered evidence')), { acknowledged: 0 })
})

test('drain bounds delivery and retains entries after an invalid or late acknowledgment', posix, async t => {
  const { open } = await fixture(t)
  const store = await open({ initialize: true })
  await store.onCompleted(completed)
  await store.onCompleted({ ...completed, scope: { ...scope, dispatchId: 'next' } })
  const pending = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const timed = store.drain((entry, { signal }) => {
    entered.resolve({ entry, signal })
    return pending.promise
  }, { timeoutMs: 50 })
  const { entry, signal } = await entered.promise
  await assert.rejects(store.drain(() => assert.fail('concurrent drain called ingest')), invalid)
  assert.deepEqual(await timed, { acknowledged: 0 })
  assert.equal(signal.aborted, true)
  pending.resolve({ inserted: true })
  assert.deepEqual(await store.drain(candidate => {
    assert.deepEqual(candidate, entry)
    return { inserted: 'true' }
  }), { acknowledged: 0 })
  assert.deepEqual(await store.drain(candidate => {
    assert.deepEqual(candidate, entry)
    return { inserted: true }
  }, { limit: 1 }), { acknowledged: 1 })
  assert.deepEqual(await store.drain(candidate => {
    assert.equal(candidate.scope.dispatchId, 'next')
    return { inserted: true }
  }), { acknowledged: 1 })
})

test('invalid observations and corrupt storage cannot publish evidence', posix, async t => {
  const { file, open } = await fixture(t)
  const store = await open({ initialize: true })
  for (const input of [{ ...completed, status: 'unknown' }, { ...completed, evidenceId: 'supplied' },
    { ...completed, scope: { ...scope, path: '/fixture' } }, { ...completed, scope: { ...scope, contentDigest: null } },
  ]) await assert.rejects(store.onCompleted(input), invalid)
  await store.onCompleted(completed)
  await assert.rejects(store.onCompleted({ ...completed, scope: { ...scope, targetId: 'other' } }), invalid)
  const state = JSON.parse(await readFile(file, 'utf8'))
  const corrupt = JSON.stringify({ ...state, entries: [{ ...state.entries[0], evidenceId: 'tampered' }] })
  await writeFile(file, corrupt)
  await assert.rejects(store.drain(() => assert.fail('corrupt outbox delivered evidence')), invalid)
  await store.close()
  await assert.rejects(open({ initialize: true }), invalid)
  assert.equal(await readFile(file, 'utf8'), corrupt)
})

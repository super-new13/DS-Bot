import assert from 'node:assert/strict'
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openWorkerReceiptStore } from '../src/host/enterprise/receipt-store.js'
import { openWorkerReceipts } from '../src/host/enterprise/worker-receipts.js'

const scope = { nodeId: 'node-a', botId: 'bot-a', personId: 'person-a', sessionId: 'session-a' }
const digest = 'a'.repeat(64)
const invalid = { code: 'invalid-receipt-state' }

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsbot-receipts-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, path: join(directory, 'receipts.json') }
}

test('only one concurrent admission wins and reopening preserves completed and uncertain work', async t => {
  const { path } = await fixture(t)
  const storage = await openWorkerReceiptStore(path, { initialize: true })
  const receipts = await openWorkerReceipts({ ...storage, now: () => 100 })
  const results = await Promise.all(Array.from({ length: 12 }, () => receipts.admit(scope, 'done', digest)))
  assert.equal(results.filter(result => result.admitted).length, 1)
  await receipts.finish(scope, 'done', 'completed')
  await receipts.admit(scope, 'waiting', digest)

  const restarted = await openWorkerReceipts(await openWorkerReceiptStore(path))
  assert.deepEqual(await restarted.lookup(scope, 'done'), { requestId: 'done', status: 'completed', admittedAt: 100, finishedAt: 100 })
  assert.equal(await restarted.lookup({ ...scope, personId: 'foreign' }, 'done'), undefined)
  assert.deepEqual(await restarted.admit(scope, 'waiting', digest), {
    admitted: false, receipt: { requestId: 'waiting', status: 'unknown', admittedAt: 100 },
  })
  await assert.rejects(receipts.finish(scope, 'waiting', 'completed'), { code: 'not-authorized' })
})

test('opens only provisioned stores and refuses corrupt snapshots without resetting them', async t => {
  const { path } = await fixture(t)
  await assert.rejects(openWorkerReceiptStore(path), { code: 'ENOENT' })
  const storage = await openWorkerReceiptStore(path, { initialize: true })
  assert.deepEqual(await storage.read(), { version: 1, generation: null, receipts: {} })
  for (const corrupt of ['{"version":', JSON.stringify({
    version: 1, generation: 'generation', receipts: { 'request:bad': { scope, inputDigest: 'invalid' } },
  })]) {
    await writeFile(path, corrupt)
    await assert.rejects(storage.read(), invalid)
    await assert.rejects(openWorkerReceiptStore(path, { initialize: true }), invalid)
    assert.equal(await readFile(path, 'utf8'), corrupt)
  }
})

test('atomically replaces the file and leaves prior bytes intact on transaction failure', async t => {
  const { path, directory } = await fixture(t)
  const storage = await openWorkerReceiptStore(path, { initialize: true })
  const previous = await open(path, 'r')
  try {
    const before = await previous.stat()
    await storage.transact(draft => { draft.generation = 'next-generation' })
    assert.notEqual((await stat(path)).ino, before.ino)
    assert.equal(JSON.parse(await previous.readFile('utf8')).generation, null)
  } finally {
    await previous.close()
  }
  const committed = await readFile(path, 'utf8')
  await assert.rejects(storage.transact(draft => { draft.version = 2 }), invalid)
  await assert.rejects(storage.transact(async draft => { draft.generation = 'ignored' }), /require a synchronous callback/)
  assert.equal(await readFile(path, 'utf8'), committed)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(directory), ['receipts.json'])
  await storage.transact(draft => { draft.generation = 'after-failure' })
  assert.equal((await storage.read()).generation, 'after-failure')
})


test('room receipt ownership survives restart and separates rooms, actors and private chat', async t => {
  const { path } = await fixture(t)
  const room = { ...scope, roomId: 'room-a' }
  const first = await openWorkerReceipts(await openWorkerReceiptStore(path, { initialize: true }))
  await first.admit(room, 'room-request', digest)
  await first.finish(room, 'room-request', 'completed')
  const restarted = await openWorkerReceipts(await openWorkerReceiptStore(path))
  assert.equal((await restarted.lookup(room, 'room-request')).status, 'completed')
  for (const foreign of [scope, { ...room, roomId: 'room-b' }, { ...room, personId: 'person-b' }]) {
    assert.equal(await restarted.lookup(foreign, 'room-request'), undefined)
    await assert.rejects(restarted.admit(foreign, 'room-request', digest), { code: 'not-authorized' })
    await assert.rejects(restarted.finish(foreign, 'room-request', 'completed'), { code: 'not-authorized' })
  }
  await assert.rejects(restarted.admit({ ...scope, roomId: undefined }, 'invalid', digest), { code: 'not-authorized' })
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openWorkerReceipts } from '../src/host/enterprise/worker-receipts.js'

const owner = Object.freeze({ nodeId: 'worker-a', botId: 'helper', personId: 'alice', sessionId: 'session-a' })
const digest = text => createHash('sha256').update(text).digest('hex')
const input = digest('mock worker prompt')
const denied = { code: 'not-authorized' }
const conflict = { code: 'receipt-conflict' }

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ds-bot-worker-receipts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'receipts.json')
  const staging = join(dir, 'receipts.next')
  await writeFile(file, JSON.stringify({ version: 1, generation: null, receipts: {} }))
  let clock = 100
  let failCommit = false
  let queue = Promise.resolve()
  async function read() {
    return JSON.parse(await readFile(file, 'utf8'))
  }
  const store = {
    read,
    now: () => clock,
    transact(change) {
      const task = queue.then(async () => {
        const state = await read()
        const result = change(state)
        if (failCommit) throw new Error('mock commit failed')
        await writeFile(staging, JSON.stringify(state))
        await rename(staging, file)
        return result
      })
      queue = task.catch(() => {})
      return task
    },
  }
  return { store, tick: () => ++clock, fail: value => { failCommit = value } }
}

test('concurrent matching submissions yield exactly one durable admission', async t => {
  const { store } = await fixture(t)
  const receipts = await openWorkerReceipts(store)
  const duplicate = () => receipts.admit(owner, '__proto__', input)
  const results = await Promise.all(Array.from({ length: 6 }, duplicate))
  assert.equal(results.filter(result => result.admitted).length, 1)
  const expected = { requestId: '__proto__', admittedAt: 100, status: 'admitted' }
  for (const { receipt } of results) assert.deepEqual(receipt, expected)
  assert.deepEqual(await receipts.lookup(owner, '__proto__'), expected)
  await assert.rejects(receipts.admit(owner, '__proto__', digest('different mock prompt')), conflict)
  assert.equal(Object.keys((await store.read()).receipts).length, 1)
})

test('foreign scope cannot observe, admit, or finish an existing receipt', async t => {
  const { store } = await fixture(t)
  const receipts = await openWorkerReceipts(store)
  await receipts.admit(owner, 'request-a', input)
  for (const field of Object.keys(owner)) {
    const foreign = { ...owner, [field]: 'other' }
    assert.equal(await receipts.lookup(foreign, 'request-a'), undefined)
    assert.equal(await receipts.lookup(foreign, 'missing'), undefined)
    await assert.rejects(receipts.admit(foreign, 'request-a', input), denied)
    await assert.rejects(receipts.finish(foreign, 'request-a', 'completed'), denied)
  }
  await assert.rejects(receipts.finish(owner, 'missing', 'completed'), denied)
  assert.equal((await receipts.lookup(owner, 'request-a')).status, 'admitted')
})

test('restart preserves terminal receipts and marks unfinished admission unknown without re-admitting it', async t => {
  const { store, tick } = await fixture(t)
  const first = await openWorkerReceipts(store)
  await first.admit(owner, 'unfinished', input)
  const outcomes = ['completed', 'aborted', 'failed']
  for (const status of outcomes) {
    await first.admit(owner, status, input)
    const finishedAt = tick()
    assert.deepEqual(await first.finish(owner, status, status), { requestId: status, status, admittedAt: finishedAt - 1, finishedAt })
  }
  const restarted = await openWorkerReceipts(store)
  for (const status of outcomes) {
    const saved = await restarted.lookup(owner, status)
    assert.equal(saved.status, status)
    assert.deepEqual(await restarted.admit(owner, status, input), { admitted: false, receipt: saved })
    assert.deepEqual(await restarted.finish(owner, status, status), saved)
  }
  await assert.rejects(restarted.finish(owner, 'completed', 'failed'), conflict)
  const unknown = { requestId: 'unfinished', admittedAt: 100, status: 'unknown' }
  assert.deepEqual(await restarted.lookup(owner, 'unfinished'), unknown)
  assert.deepEqual(await first.lookup(owner, 'unfinished'), unknown)
  assert.deepEqual(await restarted.admit(owner, 'unfinished', input), { admitted: false, receipt: unknown })
  await assert.rejects(restarted.finish(owner, 'unfinished', 'completed'), denied)
  await assert.rejects(first.finish(owner, 'unfinished', 'completed'), denied)
  await assert.rejects(first.admit(owner, 'new', input), denied)
  assert.equal((await restarted.admit(owner, 'new', input)).admitted, true)
})

test('failed transaction does not acknowledge admission or settlement', async t => {
  const { store, fail } = await fixture(t)
  const receipts = await openWorkerReceipts(store)
  fail(true)
  await assert.rejects(receipts.admit(owner, 'request-a', input), /mock commit failed/)
  assert.equal(await receipts.lookup(owner, 'request-a'), undefined)
  fail(false)
  assert.equal((await receipts.admit(owner, 'request-a', input)).admitted, true)
  fail(true)
  await assert.rejects(receipts.finish(owner, 'request-a', 'completed'), /mock commit failed/)
  assert.equal((await receipts.lookup(owner, 'request-a')).status, 'admitted')
})

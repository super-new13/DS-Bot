import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openFileReservationStore } from '../src/host/enterprise/file-reservation-store.js'
import { createFileReservations } from '../src/host/enterprise/file-reservations.js'

const scope = { nodeId: 'node', personId: 'alice', botId: 'bot', roomId: null,
  sessionId: 'session', requestId: 'request', dispatchId: 'call', operation: 'modify',
  targetId: 'note', version: 'original', contentDigest: 'a'.repeat(64), ruleId: 'write', ruleVersion: 'one' }
const denied = { code: 'not-authorized' }
const invalid = { code: 'invalid-file-reservation-state' }
const posix = { skip: process.platform === 'win32' }

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsbot-reservation-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'reservations.json')
  async function open(options) {
    const store = await openFileReservationStore(file, options)
    t.after(store.close)
    return { ...store, policy: createFileReservations({ transact: store.transact, canReserve: () => true }) }
  }
  return { dir, file, open }
}

test('concurrent permits and revocation persist as one ordered transaction sequence', posix, async t => {
  const { file, open } = await fixture(t)
  await assert.rejects(open(), { code: 'ENOENT' })
  const first = await open({ initialize: true })
  await assert.rejects(open(), invalid)
  const another = { ...scope, dispatchId: 'second' }
  assert.deepEqual(await Promise.all([first.policy.reserve(scope), first.policy.reserve(scope), first.policy.reserve(another), first.policy.revoke('alice')]), [
    { issued: true, status: 'reserved' }, { issued: false, status: 'reserved' }, { issued: true, status: 'reserved' }, 'pending',
  ])
  await first.close()
  const reopened = await open()
  assert.equal(await reopened.policy.revoke('alice'), 'pending')
  await assert.rejects(reopened.policy.reserve({ ...scope, dispatchId: 'fresh' }), denied)
  assert.deepEqual(await reopened.policy.reserve(scope), { issued: false, status: 'reserved' })
  assert.equal(await reopened.policy.settle(scope, 'completed'), 'pending')
  assert.equal(await reopened.policy.settle(another, 'fenced'), 'revoked')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test('failed commits leave the prior snapshot intact and queued writes can recover', posix, async t => {
  const { dir, file, open } = await fixture(t)
  const store = await open({ initialize: true, maxBytes: 1024 })
  await store.policy.reserve(scope)
  const before = await readFile(file, 'utf8')
  await assert.rejects(store.policy.reserve({ ...scope, dispatchId: 'x'.repeat(256), version: 'y'.repeat(512) }),
    { code: 'file-reservation-store-full' })
  await chmod(dir, 0o755)
  await assert.rejects(store.policy.revoke('alice'), invalid)
  await chmod(dir, 0o700)
  assert.equal(await readFile(file, 'utf8'), before)
  await assert.rejects(store.transact(async draft => { draft.revocations.alice = true }), /synchronous callback/)
  await assert.rejects(store.transact(draft => { draft.revocations.alice = false }), invalid)
  assert.equal(await readFile(file, 'utf8'), before)
  assert.equal(await store.policy.revoke('alice'), 'pending')
  await assert.rejects(store.policy.reserve({ ...scope, dispatchId: 'fresh' }), denied)
})

test('corrupt snapshots refuse opening and live writes without replacement', posix, async t => {
  const { file, open } = await fixture(t)
  const store = await open({ initialize: true })
  const corrupt = '{truncated'
  await writeFile(file, corrupt)
  await assert.rejects(store.policy.revoke('alice'), invalid)
  await store.close()
  await assert.rejects(open({ initialize: true }), invalid)
  assert.equal(await readFile(file, 'utf8'), corrupt)
  const invalidScope = JSON.stringify({ version: 1, revocations: {}, reservations: { incorrect: { scope, status: 'reserved' } } })
  await writeFile(file, invalidScope)
  await assert.rejects(open(), invalid)
  assert.equal(await readFile(file, 'utf8'), invalidScope)
})

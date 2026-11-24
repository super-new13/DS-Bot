import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openEmployeeGroupStore } from '../src/host/enterprise/group-store.js'

const invalid = { code: 'invalid-group-transcript' }
const row = (roomId, text, kind = 'user') => ({ roomId, kind, text, by: kind === 'user' ? 'alice' : 'bot', name: kind === 'user' ? 'Alice' : 'Bot' })
const batch = (roomId, requestId, text) => ({ requestId, rows: [row(roomId, text), row(roomId, 'reply to ' + text, 'bot')] })
const roomFile = (dir, roomId) => join(dir, 'room-' + createHash('sha256').update(roomId).digest('hex') + '.json')

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsbot-group-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('bounded tail reads preserve exact room and order after reopening', async t => {
  const dir = await fixture(t)
  const store = await openEmployeeGroupStore(dir)
  assert.deepEqual(await store.readTail('missing'), [])
  const expected = []
  const writes = []
  for (let i = 0; i < 52; i++) {
    const turn = batch('Room', 'turn-' + i, 'message ' + i)
    expected.push(...turn.rows)
    writes.push(store.append('Room', turn))
  }
  const another = batch('room', 'turn-0', 'isolated')
  await Promise.all([...writes, store.append('room', another)])
  const reopened = await openEmployeeGroupStore(dir)
  assert.deepEqual(await reopened.readTail('Room', { limit: 10000 }), expected.slice(-100))
  assert.deepEqual(await reopened.readTail('Room', { limit: 3 }), expected.slice(-3))
  assert.deepEqual(await reopened.readTail('room'), another.rows)
  await assert.rejects(reopened.readTail('Room', { signal: AbortSignal.abort() }), { name: 'AbortError' })
  await assert.rejects(reopened.readTail('../outside'), invalid)
  const info = await stat(roomFile(dir, 'Room'))
  assert.equal(info.mode & 0o777, 0o600)
})

test('duplicate requests have one transactional winner and conflicting repeats leave history unchanged', async t => {
  const dir = await fixture(t)
  const store = await openEmployeeGroupStore(dir)
  const turn = batch('general', 'same', 'first')
  const results = await Promise.all(Array.from({ length: 5 }, () => store.append('general', turn)))
  assert.equal(results.filter(result => result.appended).length, 1)
  const reopened = await openEmployeeGroupStore(dir)
  assert.deepEqual(await reopened.append('general', turn), { appended: false })
  await assert.rejects(reopened.append('general', batch('general', 'same', 'changed')), { code: 'group-request-conflict' })
  await assert.rejects(reopened.append('general', batch('other', 'new', 'foreign')), invalid)
  assert.deepEqual(await reopened.readTail('general'), turn.rows)
  assert.equal((await readdir(dir)).length, 1)
})

test('corrupt snapshots, mixed rooms, and repeated stored IDs refuse reads and writes', async t => {
  const dir = await fixture(t)
  const store = await openEmployeeGroupStore(dir)
  const file = roomFile(dir, 'general')
  const turn = batch('general', 'old', 'first')
  for (const raw of ['{truncated', JSON.stringify({ version: 1, roomId: 'other', batches: [] }),
    JSON.stringify({ version: 1, roomId: 'general', batches: [batch('other', 'old', 'foreign'), turn] }),
    JSON.stringify({ version: 1, roomId: 'general', batches: [turn, turn] }),
  ]) {
    await writeFile(file, raw)
    await assert.rejects(store.readTail('general', { limit: 1 }), invalid)
    await assert.rejects(store.append('general', batch('general', 'new', 'second')), invalid)
    assert.equal(await readFile(file, 'utf8'), raw)
  }
})

test('capacity failures preserve committed rows and do not publish a partial batch', async t => {
  const dir = await fixture(t)
  const store = await openEmployeeGroupStore(dir, { maxRoomBytes: 512 })
  const turn = batch('general', 'old', 'first')
  const file = roomFile(dir, 'general')
  await store.append('general', turn)
  const previous = await readFile(file, 'utf8')
  await assert.rejects(store.append('general', batch('general', 'new', 'x'.repeat(512))), { code: 'group-transcript-full' })
  assert.equal(await readFile(file, 'utf8'), previous)
  assert.deepEqual(await store.readTail('general'), turn.rows)
  assert.equal((await readdir(dir)).length, 1)
})

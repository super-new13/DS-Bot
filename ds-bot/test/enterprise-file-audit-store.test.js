import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openFileAuditStore } from '../src/host/enterprise/file-audit-store.js'

const posix = { skip: process.platform === 'win32' }
const invalid = { code: 'invalid-file-audit' }
const allowed = { type: 'file-authorization', personId: 'alice', botId: 'helper', roomId: null,
  sessionId: 'session', requestId: 'request', dispatchId: 'call', operation: 'modify',
  ruleId: 'rule', ruleVersion: 'v1', verdict: 'allowed',
}
const completed = { ...allowed, type: 'file-effect', outcome: 'completed' }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsbot-file-audit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, file: join(root, 'audit.json') }
}

test('serializes accepted events, drains on close, and appends after reopening', posix, async t => {
  const { file } = await fixture(t)
  await assert.rejects(openFileAuditStore(file), { code: 'ENOENT' })
  const store = await openFileAuditStore(file, { initialize: true })
  await assert.rejects(openFileAuditStore(file), invalid)
  const events = Array.from({ length: 8 }, (_, i) => ({ ...allowed, dispatchId: 'call-' + i }))
  const operations = events.map(event => store.writeAudit(event))
  const closing = store.close()
  assert.equal(store.close(), closing)
  await assert.rejects(store.writeAudit(allowed), invalid)
  await Promise.all([...operations, closing])
  const reopened = await openFileAuditStore(file)
  try { await reopened.writeAudit(completed) } finally { await reopened.close() }
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, events: [...events, completed] })
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test('rejects unlisted event fields and malformed records without changing history', posix, async t => {
  const { file } = await fixture(t)
  const store = await openFileAuditStore(file, { initialize: true })
  t.after(store.close)
  const initial = await readFile(file, 'utf8')
  for (const bad of [{ ...allowed, path: '/fixture/path' }, { ...allowed, content: 'private' },
    { ...allowed, reason: 'private' }, { ...completed, verdict: 'denied' }, { ...allowed, ruleId: null },
    { ...completed, outcome: 'unexpected' }, { ...allowed, get personId() { throw new Error('getter called') } },
  ]) await assert.rejects(store.writeAudit(bad), invalid)
  assert.equal(await readFile(file, 'utf8'), initial)
  await store.writeAudit({ ...allowed, verdict: 'denied', ruleId: null, ruleVersion: null })
})

test('rejects corrupt snapshots and unsafe file or directory access', posix, async t => {
  const { root, file } = await fixture(t)
  for (const bytes of ['{truncated', JSON.stringify({ version: 1, events: [{ ...allowed, reason: 'private' }] })]) {
    await writeFile(file, bytes, { mode: 0o600 })
    await assert.rejects(openFileAuditStore(file, { initialize: true }), invalid)
    assert.equal(await readFile(file, 'utf8'), bytes)
  }
  await writeFile(file, JSON.stringify({ version: 1, events: [] }))
  await chmod(file, 0o644)
  await assert.rejects(openFileAuditStore(file), invalid)
  await chmod(file, 0o600)
  const alias = join(root, 'alias.json')
  await symlink(file, alias)
  await assert.rejects(openFileAuditStore(alias), { code: 'ELOOP' })
  await chmod(root, 0o755)
  await assert.rejects(openFileAuditStore(file), invalid)
})

test('failed persistence leaves the previous snapshot intact and allows later writes', posix, async t => {
  const { root, file } = await fixture(t)
  const store = await openFileAuditStore(file, { initialize: true, maxBytes: 1024 })
  t.after(store.close)
  await store.writeAudit(allowed)
  const previous = await readFile(file, 'utf8')
  await assert.rejects(store.writeAudit({ ...completed, personId: 'x'.repeat(256), botId: 'y'.repeat(256),
    dispatchId: 'z'.repeat(256), requestId: 'q'.repeat(256),
  }), { code: 'file-audit-full' })
  await chmod(root, 0o755)
  await assert.rejects(store.writeAudit(completed), invalid)
  assert.equal(await readFile(file, 'utf8'), previous)
  assert.deepEqual(await readdir(root), ['audit.json'])
  await chmod(root, 0o700)
  await store.writeAudit(completed)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).events, [allowed, completed])
})

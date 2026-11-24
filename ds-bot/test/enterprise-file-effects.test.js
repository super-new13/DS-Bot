import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createBusinessFileAuthorization } from '../src/host/enterprise/file-authorization.js'
import { createWorkerFileEffects } from '../src/host/enterprise/file-effects.js'

const posix = { skip: process.platform === 'win32' }
const refused = { code: 'not-authorized' }
const stale = { code: 'version-conflict' }

function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'dsbot-file-effects-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'owned')
  mkdirSync(root, { mode: 0o700 })
  const file = join(root, 'notes')
  const outside = join(dir, 'outside')
  writeFileSync(outside, 'outside')
  let live = true
  let counter = 0
  const rule = { personId: 'alice', botId: 'helper', roomId: null, directory: root, effect: 'allow', purpose: 'Fixture notes' }
  const authorization = createBusinessFileAuthorization({ isAuthorized: () => live,
    readRules: () => ({ version: 'rules-v1', rules: ['read', 'write'].map(grant => ({ ...rule, id: grant, grant })) }) })
  const effects = createWorkerFileEffects({ root, workerOwned: true, authorization, maxBytes: 32 })
  function prepare(operation, path, content, version = null) {
    const bytes = content === undefined ? undefined : Buffer.from(content)
    const action = { personId: 'alice', botId: 'helper', roomId: null, sessionId: 'session', requestId: 'request',
      dispatchId: String(++counter), operation, path, version, contentDigest: bytes ? createHash('sha256').update(bytes).digest('hex') : null }
    const approval = authorization.prepare(action)
    assert.ok(approval)
    assert.equal(authorization.decide(approval, 'allow'), true)
    return { approval, action, bytes }
  }
  return { root, file, outside, effects, authorization, prepare, revoke: () => { live = false } }
}

test('creates, reads, and modifies only the exact approved bytes and path', posix, t => {
  const { effects, prepare, file, root, authorization } = fixture(t)
  assert.throws(() => createWorkerFileEffects({ root, authorization }), /explicitly worker-owned/)
  const create = prepare('create', file, 'first')
  assert.throws(() => effects.execute(create.approval, create.action, Buffer.from('different')), refused)
  assert.deepEqual(effects.execute(create.approval, create.action, create.bytes), { operation: 'create' })
  assert.throws(() => effects.execute(create.approval, create.action, create.bytes), stale)
  const version = effects.inspectVersion(file)
  const read = prepare('read', file, undefined, version)
  assert.equal(effects.execute(read.approval, read.action).bytes.toString(), 'first')
  assert.throws(() => effects.execute(read.approval, read.action), refused)
  const patch = prepare('modify', file, 'second', version)
  assert.deepEqual(effects.execute(patch.approval, patch.action, patch.bytes), { operation: 'modify' })
  assert.equal(readFileSync(file, 'utf8'), 'second')
  assert.deepEqual(readdirSync(root), ['notes'])
})

test('serializes competing writes and preserves bytes after stale or revoked approval', posix, async t => {
  const { effects, prepare, file, root, revoke } = fixture(t)
  writeFileSync(file, 'initial')
  const version = effects.inspectVersion(file)
  const first = prepare('modify', file, 'first writer', version)
  const second = prepare('modify', file, 'second writer', version)
  const outcomes = await Promise.allSettled([first, second].map(({ approval, action, bytes }) =>
    Promise.resolve().then(() => effects.execute(approval, action, bytes))))
  assert.equal(outcomes[0].status, 'fulfilled')
  assert.equal(outcomes[1].reason.code, 'version-conflict')
  const current = effects.inspectVersion(file)
  const revoked = prepare('modify', file, 'revoked', current)
  const read = prepare('read', file, undefined, current)
  revoke()
  assert.throws(() => effects.execute(revoked.approval, revoked.action, revoked.bytes), refused)
  assert.throws(() => effects.execute(read.approval, read.action), refused)
  assert.equal(readFileSync(file, 'utf8'), 'first writer')
  assert.deepEqual(readdirSync(root), ['notes'])
})

test('rejects out-of-scope names, leaf and ancestor symlinks, hard links and oversized files', posix, t => {
  const { effects, root, file, outside, prepare } = fixture(t)
  symlinkSync(outside, file)
  symlinkSync(root, join(root, 'linked-parent'))
  linkSync(outside, join(root, 'other-link'))
  for (const path of [file, join(root, 'linked-parent', 'other-link'), join(root, 'other-link'), outside, root + '/../outside']) {
    assert.throws(() => effects.inspectVersion(path), refused)
  }
  const create = prepare('create', file, 'replacement')
  assert.throws(() => effects.execute(create.approval, create.action, create.bytes), refused)
  assert.equal(readFileSync(outside, 'utf8'), 'outside')
  writeFileSync(join(root, 'large'), 'x'.repeat(33))
  assert.throws(() => effects.inspectVersion(join(root, 'large')), { code: 'file-too-large' })
  const large = prepare('create', join(root, 'too-big'), 'x'.repeat(33))
  assert.throws(() => effects.execute(large.approval, large.action, large.bytes), { code: 'file-too-large' })
})

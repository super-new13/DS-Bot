import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openEmployeeAccountStore } from '../src/host/enterprise/account-store.js'
import { createEmployeeAccounts } from '../src/host/enterprise/accounts.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ds-bot-account-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { dir, file: join(dir, 'accounts.json') }
}

test('invite, login and revocation survive reopening the account store', async t => {
  const { file, dir } = await fixture(t)
  const password = 'mock store fixture password'
  await assert.rejects(openEmployeeAccountStore(file), { code: 'ENOENT' })
  const first = createEmployeeAccounts(await openEmployeeAccountStore(file, { initialize: true }))
  const invite = await first.issueInvite('alice')
  assert.equal((await readFile(file, 'utf8')).includes(invite.token), false)

  const second = createEmployeeAccounts(await openEmployeeAccountStore(file))
  assert.deepEqual(await second.redeemInvite(invite.token, password), { personId: 'alice' })
  const login = await second.login('alice', password)
  const saved = await readFile(file, 'utf8')
  for (const value of [invite.token, password, login.token]) assert.equal(saved.includes(value), false)

  const third = createEmployeeAccounts(await openEmployeeAccountStore(file))
  assert.deepEqual(await third.resolveSession(login.token), { personId: 'alice', loginSessionId: login.id })
  assert.equal(await third.revokeAccount('alice'), true)
  const fourth = createEmployeeAccounts(await openEmployeeAccountStore(file))
  assert.equal(await fourth.resolveSession(login.token), undefined)
  assert.equal(await fourth.redeemInvite(invite.token, password), undefined)
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(dir), ['accounts.json'])
})

test('concurrent commits serialize against fresh state and queued reads see committed writes', async t => {
  const { file } = await fixture(t)
  const store = await openEmployeeAccountStore(file, { initialize: true })
  const count = 20
  const writes = Array.from({ length: count }, (_, index) => store.transact(state => {
    const prior = Object.keys(state.accounts).length
    state.accounts['employee-' + index] = { passwordHash: null, revokedAt: null }
    return prior
  }))
  const read = store.read()
  assert.deepEqual(await Promise.all(writes), Array.from({ length: count }, (_, index) => index))
  const snapshot = await read
  assert.equal(Object.keys(snapshot.accounts).length, count)
  delete snapshot.accounts['employee-0']
  assert.equal(Object.keys((await store.read()).accounts).length, count)
})

test('corrupt, inconsistent, and missing storage fails closed without rewriting it', async t => {
  const { file } = await fixture(t)
  const store = await openEmployeeAccountStore(file, { initialize: true })
  const corrupt = [
    '{truncated',
    '{"accounts":{},"sessions":{}}',
    JSON.stringify({ accounts: { alice: { passwordHash: 'mock plaintext', revokedAt: null } }, sessions: [] }),
    JSON.stringify({ accounts: {}, sessions: [{ id: 'session', personId: 'missing', hash: 'a'.repeat(64), expiresAt: 1000 }] }),
  ]
  for (const bytes of corrupt) {
    await writeFile(file, bytes)
    await assert.rejects(openEmployeeAccountStore(file, { initialize: true }), /^Error: Invalid employee account store$/)
    await assert.rejects(store.read(), /Invalid employee account store/)
    await assert.rejects(store.transact(() => assert.fail('Callback must not run on corrupt storage')), /Invalid employee account store/)
    assert.equal(await readFile(file, 'utf8'), bytes)
  }
  await unlink(file)
  await assert.rejects(store.read(), { code: 'ENOENT' })
  await assert.rejects(store.transact(() => assert.fail('Callback must not run on missing storage')), { code: 'ENOENT' })
})

test('failed or asynchronous transactions discard changes and leave the queue usable', async t => {
  const { file } = await fixture(t)
  const store = await openEmployeeAccountStore(file, { initialize: true })
  const original = await readFile(file, 'utf8')
  await assert.rejects(store.transact(state => {
    state.accounts.alice = { passwordHash: null, revokedAt: null }
    throw new Error('fixture abort')
  }), /fixture abort/)
  await assert.rejects(store.transact(async state => {
    state.accounts.alice = { passwordHash: null, revokedAt: null }
    await Promise.resolve()
    throw new Error('async fixture abort')
  }), /require a synchronous callback/)
  await assert.rejects(store.transact(state => {
    state.accounts.alice = { passwordHash: 'mock plaintext', revokedAt: null }
  }), /Invalid employee account store/)
  assert.equal(await readFile(file, 'utf8'), original)
  await store.transact(state => {
    state.accounts.bob = { passwordHash: null, revokedAt: null }
  })
  assert.deepEqual(Object.keys((await store.read()).accounts), ['bob'])
})

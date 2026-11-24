import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { openEmployeeAccountStore } from '../src/host/enterprise/account-store.js'
import { createEmployeeAccounts } from '../src/host/enterprise/accounts.js'

const cli = fileURLToPath(new URL('../bin/ds-bot-enterprise-admin.mjs', import.meta.url))

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ds-bot-admin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const accountFile = join(dir, 'accounts.json')
  const configFile = join(dir, 'enterprise.json')
  const config = { accountFile, initializeAccounts: true, roster: { bots: {}, rooms: {}, people: {
    employee: { id: 'employee', name: 'Employee', botIds: [] },
    disabled: { id: 'disabled', name: 'Disabled', botIds: [], revokedAt: 1 },
  } } }
  await writeFile(configFile, JSON.stringify(config))
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', timeout: 5000 })
  const admin = (...args) => run('--config', configFile, '--service-stopped', ...args)
  const open = async initialize => createEmployeeAccounts(await openEmployeeAccountStore(accountFile, { initialize }))
  return { accountFile, configFile, config, run, admin, open }
}

function capturedToken(result) {
  assert.equal(result.status, 0)
  assert.equal(result.stderr.length, 0)
  let invitation
  try { invitation = JSON.parse(result.stdout) } catch { throw new Error('Invalid invitation output') }
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(invitation.token), 'Expected a disposable code')
  assert.ok(Number.isSafeInteger(invitation.expiresAt) && invitation.expiresAt > Date.now(), 'Expected a future expiry')
  return invitation.token
}

test('offline invite is delivered privately and revocation invalidates a login', async t => {
  const { accountFile, admin, open } = await fixture(t)
  await open(true)
  const code = capturedToken(admin('invite', 'employee'))
  assert.ok(!(await readFile(accountFile, 'utf8')).includes(code), 'Account file must only store the digest')
  const accounts = await open()
  const password = 'discarded fixture password'
  assert.deepEqual(await accounts.redeemInvite(code, password), { personId: 'employee' })
  assert.equal(await accounts.redeemInvite(code, password), undefined)
  const session = await accounts.login('employee', password)
  assert.ok(session, 'Expected a fixture login')
  assert.equal((await accounts.resolveSession(session.token)).personId, 'employee')
  const result = admin('revoke', 'employee')
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'Employee account revoked.\n')
  assert.equal(result.stderr.length, 0)
  const reopened = await open()
  assert.equal(await reopened.resolveSession(session.token), undefined)
  assert.equal(await reopened.login('employee', password), undefined)
  assert.equal(admin('invite', 'employee').status, 1)
})

test('offline confirmation and configured roster are required for writes', async t => {
  const { accountFile, configFile, config, run, admin, open } = await fixture(t)
  const help = run('--help')
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Stop the employee service and every other writer/)
  assert.match(help.stdout, /has no cross-process lock/)
  assert.equal(run('--config', configFile, 'invite', 'employee').status, 2)
  assert.equal(admin('invite', 'employee').status, 1)
  await assert.rejects(access(accountFile), { code: 'ENOENT' })
  await open(true)
  const original = await readFile(accountFile, 'utf8')
  for (const args of [['invite', 'other'], ['invite', 'disabled'], ['revoke', 'other'], ['invite', 'constructor']]) {
    const rejected = admin(...args)
    assert.equal(rejected.status, 1)
    assert.equal(rejected.stdout.length, 0)
  }
  delete config.roster.bots
  await writeFile(configFile, JSON.stringify(config))
  const invalid = admin('invite', 'employee')
  assert.equal(invalid.status, 1)
  assert.equal(invalid.stdout.length, 0)
  assert.ok(!invalid.stderr.includes(configFile))
  assert.equal(await readFile(accountFile, 'utf8'), original)
})

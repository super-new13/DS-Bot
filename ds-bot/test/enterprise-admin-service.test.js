import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openEmployeeAccountStore } from '../src/host/enterprise/account-store.js'
import { createEmployeeAccounts } from '../src/host/enterprise/accounts.js'
import { createEmployeeAdminService } from '../src/host/enterprise/admin-service.js'
import { createEnterpriseRuntimeRoster } from '../src/host/enterprise/runtime-roster.js'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsbot-admin-service-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'accounts.json')
  const store = await openEmployeeAccountStore(file, { initialize: true })
  const accounts = createEmployeeAccounts(store)
  const config = { people: { alice: { id: 'alice', name: 'Alice', botIds: [] } }, bots: {}, rooms: {} }
  const { readRoster } = createEnterpriseRuntimeRoster({ readConfig: () => config, workers: new Map() })
  const owner = Object.freeze({ role: 'owner' })
  const allowed = new Set([owner])
  const service = createEmployeeAdminService({ accounts, readRoster, isOwner: context => allowed.has(context) })
  return { file, accounts, config, readRoster, owner, allowed, service }
}

const denied = { code: 'not-authorized' }

test('untrusted contexts and unknown employees cannot mutate accounts', async t => {
  const { file, service, owner, accounts } = await fixture(t)
  const before = await readFile(file, 'utf8')
  for (const context of [undefined, { role: 'employee' }, { role: 'owner' }]) {
    await assert.rejects(service.invite(context, 'alice'), denied)
  }
  for (const personId of ['unknown', 'constructor', null]) {
    await assert.rejects(service.invite(owner, personId), denied)
    await assert.rejects(service.revoke(owner, personId), denied)
  }
  assert.equal(await readFile(file, 'utf8'), before)
  await accounts.issueInvite('alice')
  const seeded = await readFile(file, 'utf8')
  await assert.rejects(service.revoke({ role: 'employee' }, 'alice'), denied)
  assert.equal(await readFile(file, 'utf8'), seeded)
})

test('owner grants and employee eligibility are checked live before each mutation', async t => {
  const { file, service, owner, allowed, config, accounts, readRoster } = await fixture(t)
  await service.invite(owner, 'alice')
  const before = await readFile(file, 'utf8')
  allowed.delete(owner)
  await assert.rejects(service.revoke(owner, 'alice'), denied)
  allowed.add(owner)
  config.people.alice.revokedAt = 1
  await assert.rejects(service.invite(owner, 'alice'), denied)
  delete config.people.alice.revokedAt
  const revokingRoster = createEmployeeAdminService({ accounts, isOwner: context => allowed.has(context), readRoster() {
    allowed.delete(owner)
    return readRoster()
  } })
  await assert.rejects(revokingRoster.revoke(owner, 'alice'), denied)
  assert.equal(await readFile(file, 'utf8'), before)
})

test('owner invitation and revocation share the live employee account service', async t => {
  const { file, service, owner, accounts, config } = await fixture(t)
  const invitation = await service.invite(owner, 'alice')
  assert.ok(invitation?.token && Number.isSafeInteger(invitation.expiresAt))
  assert.ok(!(await readFile(file, 'utf8')).includes(invitation.token))
  const password = 'disposable employee password'
  assert.deepEqual(await accounts.redeemInvite(invitation.token, password), { personId: 'alice' })
  const session = await accounts.login('alice', password)
  assert.ok(session)
  assert.equal((await accounts.resolveSession(session.token))?.personId, 'alice')
  config.people.alice.revokedAt = 1
  assert.equal(await service.revoke(owner, 'alice'), true)
  assert.equal(await accounts.resolveSession(session.token), undefined)
  assert.equal(await accounts.login('alice', password), undefined)
})

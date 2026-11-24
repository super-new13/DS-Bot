import assert from 'node:assert/strict'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createEmployeeAccounts } from '../src/host/enterprise/accounts.js'
import { canAccessEmployeeBot, canAccessEmployeeRoom, canAccessEmployeeSession } from '../src/host/enterprise/authorization.js'

const password = 'mock password for employee fixtures'
const nextPassword = 'replacement password for employee fixtures'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ds-bot-identity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'accounts.json')
  const draft = join(dir, 'accounts.next.json')
  await writeFile(file, JSON.stringify({ accounts: {}, sessions: [] }))
  const persisted = () => readFile(file, 'utf8')
  const read = async () => JSON.parse(await persisted())
  let tail = Promise.resolve()
  const transact = change => {
    const result = tail.then(async () => {
      const snapshot = await read()
      const value = change(snapshot)
      await writeFile(draft, JSON.stringify(snapshot))
      await rename(draft, file)
      return value
    })
    tail = result.catch(() => {})
    return result
  }
  let now = 1000
  const open = () => createEmployeeAccounts({ read, transact, now: () => now })
  return { accounts: open(), open, read, persisted, advanceTo: time => { now = time } }
}

test('invite and login persist hashes only and survive reopening the account store', async t => {
  const { accounts, open, read, persisted } = await fixture(t)
  const invite = await accounts.issueInvite('alice')
  assert.equal((await persisted()).includes(invite.token), false)
  assert.match((await read()).accounts.alice.invite.hash, /^[0-9a-f]{64}$/)
  assert.deepEqual(await open().redeemInvite(invite.token, password), { personId: 'alice' })
  assert.equal((await read()).accounts.alice.invite, undefined)
  assert.match((await read()).accounts.alice.passwordHash, /^scrypt-v1:[0-9a-f]{32}:[0-9a-f]{64}$/)
  const session = await accounts.login('alice', password)
  assert.match((await read()).sessions[0].hash, /^[0-9a-f]{64}$/)
  const saved = await persisted()
  for (const value of [invite.token, password, session.token]) assert.equal(saved.includes(value), false)
  assert.deepEqual(await open().resolveSession(session.token), { personId: 'alice', loginSessionId: session.id })
  assert.equal(await open().resolveSession(session.id), undefined)
  assert.equal(await open().resolveSession(invite.token), undefined)
})

test('expiration, replacement, and concurrent invite redemption deny invalid or replayed tokens', async t => {
  const { accounts, open, advanceTo } = await fixture(t)
  const expired = await accounts.issueInvite('alice')
  advanceTo(expired.expiresAt)
  assert.equal(await accounts.redeemInvite(expired.token, password), undefined)
  const obsolete = await accounts.issueInvite('alice')
  const current = await accounts.issueInvite('alice')
  assert.equal(await accounts.redeemInvite(obsolete.token, password), undefined)
  const attempts = await Promise.all([
    accounts.redeemInvite(current.token, password),
    open().redeemInvite(current.token, password),
  ])
  assert.deepEqual(attempts.filter(Boolean), [{ personId: 'alice' }])
  assert.equal(await accounts.redeemInvite(current.token, password), undefined)
  assert.equal(await accounts.issueInvite('alice'), undefined)
})

test('login sessions can expire or be revoked individually and account revocation denies all devices', async t => {
  const { accounts, advanceTo } = await fixture(t)
  const invite = await accounts.issueInvite('alice')
  await accounts.redeemInvite(invite.token, password)
  const first = await accounts.login('alice', password)
  const second = await accounts.login('alice', password)
  const firstContext = await accounts.resolveSession(first.token)
  assert.equal(await accounts.isSessionActive(firstContext), true)
  assert.equal(await accounts.isSessionActive({ ...firstContext, personId: 'bob' }), false)
  assert.equal(await accounts.revokeSession('bob', first.id), false)
  assert.equal(await accounts.revokeSession('alice', first.id), true)
  assert.equal(await accounts.resolveSession(first.token), undefined)
  assert.equal(await accounts.isSessionActive(firstContext), false)
  assert.ok(await accounts.resolveSession(second.token))
  advanceTo(second.expiresAt)
  assert.equal(await accounts.resolveSession(second.token), undefined)
  const third = await accounts.login('alice', password)
  const fourth = await accounts.login('alice', password)
  const fourthContext = await accounts.resolveSession(fourth.token)
  const reset = await accounts.issueInvite('alice', { reset: true })
  assert.equal(await accounts.revokeAccount('alice'), true)
  assert.equal(await accounts.resolveSession(third.token), undefined)
  assert.equal(await accounts.resolveSession(fourth.token), undefined)
  assert.equal(await accounts.isSessionActive(fourthContext), false)
  assert.equal(await accounts.login('alice', password), undefined)
  assert.equal(await accounts.redeemInvite(reset.token, nextPassword), undefined)
  assert.equal(await accounts.issueInvite('alice', { reset: true }), undefined)
})

test('password reset consumes the reset invite and invalidates the old password and sessions', async t => {
  const { accounts, read, persisted } = await fixture(t)
  const invite = await accounts.issueInvite('alice')
  await accounts.redeemInvite(invite.token, password)
  const before = (await read()).accounts.alice.passwordHash
  assert.equal(await accounts.login('alice', nextPassword), undefined)
  const session = await accounts.login('alice', password)
  const reset = await accounts.issueInvite('alice', { reset: true })
  assert.ok(await accounts.resolveSession(session.token))
  assert.deepEqual(await accounts.redeemInvite(reset.token, nextPassword), { personId: 'alice' })
  assert.notEqual((await read()).accounts.alice.passwordHash, before)
  assert.equal((await persisted()).includes(nextPassword), false)
  assert.equal(await accounts.resolveSession(session.token), undefined)
  assert.equal(await accounts.login('alice', password), undefined)
  assert.ok(await accounts.login('alice', nextPassword))
  assert.equal(await accounts.redeemInvite(reset.token, password), undefined)
})

test('chat authorization checks exact session ownership and fresh bot or room membership', () => {
  const state = {
    people: { alice: { id: 'alice', botIds: ['bot', 'hidden'] }, bob: { id: 'bob', botIds: ['bot'] } },
    bots: { bot: { id: 'bot' }, hidden: { id: 'hidden', private: true } },
    rooms: { room: { id: 'room', people: ['alice'] }, legacy: { id: 'legacy' } },
  }
  const privateChat = { kind: 'private', sessionId: 'chat-a', personId: 'alice', botId: 'bot' }
  const roomChat = { kind: 'room', sessionId: 'chat-room', roomId: 'room' }
  assert.equal(canAccessEmployeeSession(state, 'alice', 'chat-a', privateChat), true)
  assert.equal(canAccessEmployeeSession(state, 'bob', 'chat-a', privateChat), false)
  assert.equal(canAccessEmployeeSession(state, 'alice', 'other-part', privateChat), false)
  assert.equal(canAccessEmployeeSession(state, 'alice', 'chat-a', { ...privateChat, personId: undefined }), false)
  assert.equal(canAccessEmployeeSession(state, 'alice', 'chat-a', { ...privateChat, kind: 'unknown' }), false)
  assert.equal(canAccessEmployeeSession(state, 'alice', 'chat-a', undefined), false)
  assert.equal(canAccessEmployeeBot(state, 'alice', 'hidden'), false)
  assert.equal(canAccessEmployeeBot(state, 'alice', 'missing'), false)
  assert.equal(canAccessEmployeeRoom(state, 'alice', 'legacy'), false)
  assert.equal(canAccessEmployeeRoom(state, 'alice', 'missing'), false)
  assert.equal(canAccessEmployeeSession(state, 'alice', 'chat-room', roomChat), true)
  assert.equal(canAccessEmployeeSession(state, 'bob', 'chat-room', roomChat), false)
  assert.equal(canAccessEmployeeRoom(state, 'owner', 'room'), false)
  state.people.alice.botIds = []
  assert.equal(canAccessEmployeeSession(state, 'alice', 'chat-a', privateChat), false)
  assert.equal(canAccessEmployeeSession(state, 'alice', 'chat-room', roomChat), true)
  state.rooms.room.people = []
  assert.equal(canAccessEmployeeSession(state, 'alice', 'chat-room', roomChat), false)
  state.rooms.room.people = ['alice']
  state.people.alice.botIds = ['bot']
  state.people.alice.revokedAt = 0
  assert.equal(canAccessEmployeeSession(state, 'alice', 'chat-a', privateChat), false)
  assert.equal(canAccessEmployeeSession(state, 'alice', 'chat-room', roomChat), false)
})

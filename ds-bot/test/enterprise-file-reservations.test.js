import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFileReservations } from '../src/host/enterprise/file-reservations.js'

const scope = { nodeId: 'node', personId: 'alice', botId: 'bot', roomId: null,
  sessionId: 'session', requestId: 'request', dispatchId: 'call', operation: 'modify',
  targetId: 'note', version: 'original', contentDigest: 'a'.repeat(64), ruleId: 'write', ruleVersion: 'one' }
const denied = { code: 'not-authorized' }

function fixture() {
  let persisted = JSON.stringify({ version: 1, revocations: {}, reservations: {} })
  let tail = Promise.resolve()
  const transact = change => {
    const next = tail.then(() => {
      const state = JSON.parse(persisted)
      const result = change(state)
      persisted = JSON.stringify(state)
      return result
    })
    tail = next.catch(() => {})
    return next
  }
  return canReserve => createFileReservations({ transact, canReserve })
}

test('revocation blocks new permits and waits for every previously reserved effect', async () => {
  const open = fixture()
  const first = open(() => true)
  const second = { ...scope, dispatchId: 'second' }
  assert.deepEqual(await Promise.all([first.reserve(scope), first.reserve(second), first.revoke('alice')]), [
    { issued: true, status: 'reserved' }, { issued: true, status: 'reserved' }, 'pending',
  ])
  const restarted = open(() => true)
  assert.equal(await restarted.revoke('alice'), 'pending')
  await assert.rejects(restarted.reserve({ ...scope, dispatchId: 'new' }), denied)
  assert.deepEqual(await restarted.reserve(scope), { issued: false, status: 'reserved' })
  assert.equal(await restarted.settle(scope, 'completed'), 'pending')
  assert.equal(await restarted.settle(second, 'fenced'), 'revoked')
  assert.equal(await restarted.settle(second, 'fenced'), 'revoked')
  await assert.rejects(restarted.settle(second, 'completed'), denied)
  assert.deepEqual(await restarted.reserve(scope), { issued: false, status: 'completed' })
})

test('revocation ordered first rejects a competing reservation', async () => {
  const policy = fixture()(() => true)
  assert.equal(await policy.revoke('alice'), 'revoked')
  await assert.rejects(policy.reserve(scope), denied)
  assert.deepEqual(await policy.reserve({ ...scope, personId: 'bob' }), { issued: true, status: 'reserved' })
})

test('a changed scope or an uncertain outcome cannot settle a reservation', async () => {
  let allowed = false
  const policy = fixture()(() => allowed)
  await assert.rejects(policy.reserve(scope), denied)
  allowed = true
  await policy.reserve(scope)
  await assert.rejects(policy.reserve({ ...scope, targetId: 'other' }), denied)
  await assert.rejects(policy.settle({ ...scope, roomId: 'room' }, 'completed'), denied)
  await assert.rejects(async () => policy.settle(scope, 'unknown'), denied)
  assert.equal(await policy.revoke('alice'), 'pending')
  assert.equal(await policy.settle(scope, 'cancelled'), 'revoked')
})

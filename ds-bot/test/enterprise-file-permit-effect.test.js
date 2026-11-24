import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkerFileDispatch } from '../src/host/enterprise/file-dispatch.js'
import { createWorkerFileEffects } from '../src/host/enterprise/file-effects.js'
import { createFileReservations } from '../src/host/enterprise/file-reservations.js'

const actor = { personId: 'alice', botId: 'helper', roomId: 'room', sessionId: 'session', requestId: 'request', dispatchId: 'call' }
const posix = { skip: process.platform === 'win32' }
const denied = { code: 'not-authorized' }

function fixture(t, { canReserve = () => true } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dsbot-file-permit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'notes')
  const other = join(root, 'other')
  for (const file of [path, other]) writeFileSync(file, 'initial')
  const { inspectVersion } = createWorkerFileEffects({ root, workerOwned: true, authorization: { consume: () => false } })
  const input = { operation: 'modify', path, version: inspectVersion(path), content: Buffer.from('approved') }
  const exact = { ...actor, nodeId: 'worker', targetId: 'registered-note', operation: input.operation, version: input.version,
    contentDigest: createHash('sha256').update(input.content).digest('hex'), ruleId: 'notes', ruleVersion: 'rules-v1',
  }
  const state = { live: true, ruleVersion: exact.ruleVersion }
  const ledger = { version: 1, revocations: {}, reservations: {} }
  const central = createFileReservations({ transact: async change => change(ledger), canReserve })
  const audited = []
  function makeDispatch(reserve, writeAudit = event => audited.push(event.type)) {
    return createWorkerFileDispatch({ root, workerOwned: true, writeAudit,
      permit: { nodeId: exact.nodeId, targetId: exact.targetId, path, client: { reserve } },
      isAuthorized: () => state.live,
      readRules: () => ({ version: state.ruleVersion, rules: [{ id: exact.ruleId, personId: actor.personId,
        roomId: actor.roomId, botId: actor.botId, directory: root, grant: 'write', effect: 'allow', purpose: 'Maintain notes',
      }] }),
      adjudicate: ({ rule }) => ({ verdict: 'allow', ruleId: rule.id, ruleVersion: rule.version, reason: 'Fixture approval' }),
    })
  }
  return { central, exact, state, path, other, input, inspectVersion, audited, makeDispatch }
}

test('reserves the exact approved scope after authorization audit and before effect', posix, async t => {
  const { central, exact, input, path, audited, makeDispatch } = fixture(t)
  const dispatch = makeDispatch(async scope => {
    assert.ok(Object.isFrozen(scope))
    assert.deepEqual(scope, exact)
    assert.deepEqual(audited, ['file-authorization'])
    assert.equal(readFileSync(path, 'utf8'), 'initial')
    input.content.fill(120)
    return central.reserve(scope)
  })
  assert.deepEqual(await dispatch(actor, input), { operation: 'modify' })
  assert.equal(readFileSync(path, 'utf8'), 'approved')
  assert.deepEqual(audited, ['file-authorization', 'file-effect'])
  assert.equal(await central.revoke(actor.personId), 'pending')
})

test('loss after reservation and duplicate admission cannot authorize an effect', posix, async t => {
  const { central, exact, input, path, makeDispatch } = fixture(t)
  const lost = { code: 'reservation-outcome-unknown' }
  await assert.rejects(makeDispatch(async scope => {
    assert.deepEqual(await central.reserve(scope), { issued: true, status: 'reserved' })
    throw Object.assign(new Error('Fixture response lost'), lost)
  })(actor, input), lost)
  assert.equal(readFileSync(path, 'utf8'), 'initial')
  await assert.rejects(makeDispatch(central.reserve)(actor, input), denied)
  assert.deepEqual(await central.reserve(exact), { issued: false, status: 'reserved' })
  assert.equal(readFileSync(path, 'utf8'), 'initial')
})

test('a different local target and mismatched central reservation both fail closed', posix, async t => {
  const { central, exact, input, path, other, inspectVersion, makeDispatch } = fixture(t)
  await assert.rejects(makeDispatch(() => assert.fail('unregistered path reached center'))(actor,
    { ...input, path: other, version: inspectVersion(other) }), denied)
  await central.reserve({ ...exact, targetId: 'another-target' })
  await assert.rejects(makeDispatch(central.reserve)(actor, input), denied)
  assert.equal(readFileSync(path, 'utf8'), 'initial')
  assert.equal(readFileSync(other, 'utf8'), 'initial')
})

for (const change of ['revocation', 'rule version', 'abort']) {
  test('local ' + change + ' while awaiting a confirmed permit blocks the effect', posix, async t => {
    const { central, state, input, path, makeDispatch } = fixture(t)
    const controller = new AbortController()
    const dispatch = makeDispatch(async (scope, { signal }) => {
      assert.equal(signal, controller.signal)
      const confirmation = await central.reserve(scope)
      if (change === 'revocation') state.live = false
      if (change === 'rule version') state.ruleVersion = 'rules-v2'
      if (change === 'abort') controller.abort()
      return confirmation
    })
    await assert.rejects(dispatch(actor, input, { signal: controller.signal }), denied)
    assert.equal(readFileSync(path, 'utf8'), 'initial')
    assert.equal(await central.revoke(actor.personId), 'pending')
  })
}

test('failed pre-effect audit prevents reservation and mutation', posix, async t => {
  const { input, path, makeDispatch } = fixture(t)
  await assert.rejects(makeDispatch(() => assert.fail('reached center after audit failure'), () => false)(actor, input),
    { code: 'file-audit-unavailable' })
  assert.equal(readFileSync(path, 'utf8'), 'initial')
})

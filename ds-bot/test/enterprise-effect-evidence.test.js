import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkerFileDispatch } from '../src/host/enterprise/file-dispatch.js'
import { createWorkerFileEffects } from '../src/host/enterprise/file-effects.js'
import { createFileReservationHttpHandler } from '../src/host/enterprise/file-reservation-http.js'
import { openFileReservationStore } from '../src/host/enterprise/file-reservation-store.js'
import { createFileReservations } from '../src/host/enterprise/file-reservations.js'
import { openFileSettlementEvidence } from '../src/host/enterprise/file-settlement-evidence.js'

const actor = { personId: 'alice', botId: 'helper', roomId: null, sessionId: 'session', requestId: 'request', dispatchId: 'call' }
const peer = Object.freeze({})
const origin = 'https://center.example.test'
const posix = { skip: process.platform === 'win32' }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function fixture(t, operation, { losePermit = false, loseEvidence = false } = {}) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'dsbot-effect-evidence-'))
  const root = join(dir, 'owned')
  const stores = []
  t.after(async () => {
    try { await Promise.all(stores.map(store => store.close())) }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
  mkdirSync(root, { mode: 0o700 })
  const path = join(root, 'note')
  const content = Buffer.from('updated')
  writeFileSync(path, 'initial')
  const guard = createWorkerFileEffects({ root, workerOwned: true, authorization: { consume: () => false } })
  const input = { operation, path, version: guard.inspectVersion(path), ...(operation === 'modify' && { content }) }
  const scope = { ...actor, nodeId: 'node', operation, targetId: 'note', version: input.version,
    contentDigest: operation === 'read' ? null : digest(content), ruleId: 'rule', ruleVersion: 'v1',
  }
  const proof = { scope, status: 'completed', evidenceId: 'effect-record' }
  const producer = Symbol('fixture trusted effect observer')
  async function open(initialize) {
    const reservations = await openFileReservationStore(join(dir, 'reservations.json'), { initialize })
    stores.push(reservations)
    const evidence = await openFileSettlementEvidence(join(dir, 'evidence.json'), { initialize, trustedProducer: producer })
    stores.push(evidence)
    const policy = createFileReservations({ transact: reservations.transact, canReserve: () => true })
    const handle = createFileReservationHttpHandler({ origin, reservations: policy,
      authenticateWorker: metadata => metadata === peer ? 'node' : undefined,
      authorizeScope: () => true, verifySettlement: evidence.verifySettlement,
    })
    return { policy, evidence, async close() { await Promise.all([reservations.close(), evidence.close()]) },
      settle: claim => handle(new Request(origin + '/internal/enterprise/file-reservations/settle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(claim),
      }), peer),
    }
  }
  const first = await open(true)
  const observed = []
  const dispatch = createWorkerFileDispatch({ root, workerOwned: true, isAuthorized: () => true,
    permit: { nodeId: scope.nodeId, targetId: scope.targetId, path, client: { async reserve(proposed) {
      assert.deepEqual(proposed, scope)
      const reply = await first.policy.reserve(proposed)
      if (losePermit) throw Object.assign(new Error('Fixture lost permit acknowledgment'), { code: 'reservation-outcome-unknown' })
      return reply
    } } },
    readRules: () => ({ version: scope.ruleVersion, rules: [{ id: scope.ruleId, personId: actor.personId, botId: actor.botId,
      roomId: null, directory: root, grant: operation === 'read' ? 'read' : 'write', effect: 'allow', purpose: 'Fixture note',
    }] }),
    adjudicate: ({ rule }) => ({ verdict: 'allow', ruleId: rule.id, ruleVersion: rule.version, reason: 'Fixture approval' }),
    async writeAudit(event) {
      if (event.type !== 'file-effect') return
      observed.push(event.outcome)
      const { type, outcome, verdict, ...record } = event
      const { personId, botId, roomId, sessionId, requestId, dispatchId, operation, ruleId, ruleVersion } = scope
      assert.deepEqual(record, { personId, botId, roomId, sessionId, requestId, dispatchId, operation, ruleId, ruleVersion })
      if (outcome === 'completed' && verdict === 'allowed') {
        if (loseEvidence) throw new Error('Fixture lost the observation before persistence')
        await first.evidence.ingest(producer, proof)
      }
    },
  })
  return { first, open, proof, scope, path, content, observed, dispatch: () => dispatch(actor, input) }
}

for (const operation of ['read', 'modify']) {
  test('trusted ' + operation + ' completion can be settled after reopening', posix, async t => {
    const { first, open, proof, scope, path, content, observed, dispatch } = await fixture(t, operation)
    const result = await dispatch()
    assert.equal(result.auditIncomplete, undefined)
    assert.deepEqual(observed, ['completed'])
    if (operation === 'read') assert.equal(result.bytes.toString(), 'initial')
    else assert.deepEqual(readFileSync(path), content)
    assert.equal(await first.policy.revoke(actor.personId), 'pending')
    await first.close()
    const reopened = await open(false)
    assert.equal(await reopened.evidence.verifySettlement(scope.nodeId, proof), true)
    assert.equal((await reopened.settle({ ...proof, scope: { ...scope, targetId: 'other' } })).status, 403)
    const settled = await reopened.settle(proof)
    assert.equal(settled.status, 200)
    assert.deepEqual(await settled.json(), { revocation: 'revoked' })
  })
}

test('interruption before execution leaves a reservation pending even when target bytes match', posix, async t => {
  const { first, open, proof, scope, path, content, observed, dispatch } = await fixture(t, 'modify', { losePermit: true })
  await assert.rejects(dispatch(), { code: 'reservation-outcome-unknown' })
  assert.deepEqual(observed, [])
  assert.equal(readFileSync(path, 'utf8'), 'initial')
  assert.equal(await first.policy.revoke(actor.personId), 'pending')
  await first.close()
  writeFileSync(path, content)
  const reopened = await open(false)
  assert.equal(digest(readFileSync(path)), scope.contentDigest)
  assert.equal((await reopened.settle(proof)).status, 403)
  assert.equal((await reopened.settle({ ...proof, status: 'cancelled' })).status, 403)
  assert.equal(await reopened.policy.revoke(actor.personId), 'pending')
})

test('loss of the effect observation before durable recording does not settle a committed write', posix, async t => {
  const { first, open, proof, scope, path, content, observed, dispatch } = await fixture(t, 'modify', { loseEvidence: true })
  assert.deepEqual(await dispatch(), { operation: 'modify', auditIncomplete: true })
  assert.deepEqual(observed, ['completed'])
  assert.deepEqual(readFileSync(path), content)
  await first.close()
  const reopened = await open(false)
  assert.equal((await reopened.settle(proof)).status, 403)
  assert.deepEqual(await reopened.policy.reserve(scope), { issued: false, status: 'reserved' })
  assert.equal(await reopened.policy.revoke(actor.personId), 'pending')
})

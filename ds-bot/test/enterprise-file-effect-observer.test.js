import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkerFileDispatch } from '../src/host/enterprise/file-dispatch.js'
import { createWorkerFileEffects } from '../src/host/enterprise/file-effects.js'
import { createFileReservations } from '../src/host/enterprise/file-reservations.js'

const actor = { personId: 'alice', botId: 'helper', roomId: null, sessionId: 'session', requestId: 'request', dispatchId: 'call' }
const posix = { skip: process.platform === 'win32' }
const denied = { code: 'not-authorized' }

function fixture(t, { operation = 'modify', reserve, observe, writeAudit } = {}) {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'dsbot-effect-observer-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'note')
  fs.writeFileSync(path, 'original')
  const guard = createWorkerFileEffects({ root, workerOwned: true, authorization: { consume: () => false } })
  const content = Buffer.from('updated')
  const input = { operation, path, version: guard.inspectVersion(path), ...(operation === 'modify' && { content }) }
  const ledger = { version: 1, revocations: {}, reservations: {} }
  const center = createFileReservations({ transact: async change => change(ledger), canReserve: () => true })
  const observations = []
  const permits = []
  let allowed = true
  const options = { root, workerOwned: true, isAuthorized: () => allowed,
    permit: { nodeId: 'node', targetId: 'note', path, client: { async reserve(scope, { signal }) {
      permits.push(scope)
      return reserve ? reserve(center, scope, signal) : center.reserve(scope)
    } } },
    readRules: () => ({ version: 'v1', rules: [{ id: 'rule', personId: actor.personId, botId: actor.botId,
      roomId: null, directory: root, grant: operation === 'read' ? 'read' : 'write', effect: 'allow', purpose: 'Fixture note',
    }] }),
    adjudicate: ({ rule }) => ({ verdict: 'allow', ruleId: rule.id, ruleVersion: rule.version, reason: 'Fixture approval' }),
    writeAudit,
    async onCompleted(event) {
      observations.push(event)
      return observe?.(event, path)
    },
  }
  return { path, input, options, permits, observations, revoke: () => { allowed = false },
    start: () => {
      const run = createWorkerFileDispatch(options)
      return (context, scope = actor) => run(scope, input, context)
    },
  }
}

for (const operation of ['read', 'modify']) {
  test('reports one exact completion for a guarded ' + operation, posix, async t => {
    const { start, input, permits, observations } = fixture(t, { operation })
    const dispatch = start()
    const result = await dispatch()
    if (operation === 'read') assert.equal(result.bytes.toString(), 'original')
    else assert.deepEqual(result, { operation })
    assert.deepEqual(observations, [{ scope: {
      ...actor, nodeId: 'node', targetId: 'note', operation, version: input.version, ruleId: 'rule', ruleVersion: 'v1',
      contentDigest: operation === 'read' ? null : createHash('sha256').update(input.content).digest('hex'),
    }, status: 'completed' }])
    assert.equal(observations[0].scope, permits[0])
    assert.ok(Object.isFrozen(observations[0]))
    assert.ok(Object.isFrozen(observations[0].scope))
    await assert.rejects(dispatch(), denied)
    await assert.rejects(start()(), denied)
    assert.equal(observations.length, 1)
  })
}

test('observer setup requires a permit and denied, interrupted or cancelled effects yield no evidence', posix, async t => {
  const controller = new AbortController()
  let mode = 'lost'
  const { start, options, path, observations, revoke } = fixture(t, { reserve: async (center, scope) => {
    const result = await center.reserve(scope)
    if (mode === 'lost') throw Object.assign(new Error('Fixture lost acknowledgment'), { code: 'reservation-outcome-unknown' })
    if (mode === 'cancel') controller.abort()
    if (mode === 'revoke') revoke()
    return result
  } })
  assert.throws(() => createWorkerFileDispatch({ ...options, permit: undefined }), /requires a permit gate/)
  const run = start()
  await assert.rejects(run(), { code: 'reservation-outcome-unknown' })
  mode = 'cancel'
  await assert.rejects(run({ signal: controller.signal }, { ...actor, requestId: 'cancel' }), denied)
  mode = 'revoke'
  await assert.rejects(run(undefined, { ...actor, requestId: 'revoked' }), denied)
  assert.deepEqual(observations, [])
  assert.equal(fs.readFileSync(path, 'utf8'), 'original')
})

test('publication without a confirmed directory sync yields no completion evidence', posix, async t => {
  const { start, path, observations } = fixture(t)
  const fsyncSync = fs.fsyncSync
  const patch = t.mock.method(fs, 'fsyncSync', fd => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error('Fixture directory sync failed')
    return fsyncSync(fd)
  })
  syncBuiltinESMExports()
  try {
    await assert.rejects(start()(), { code: 'file-effect-unknown' })
    assert.equal(fs.readFileSync(path, 'utf8'), 'updated')
    assert.deepEqual(observations, [])
  } finally {
    patch.mock.restore()
    syncBuiltinESMExports()
  }
})

test('failed evidence recording preserves known effect success and prevents replay', posix, async t => {
  const { start, path, observations } = fixture(t, {
    observe(_event, target) {
      assert.equal(fs.readFileSync(target, 'utf8'), 'updated')
      throw new Error('Fixture evidence unavailable')
    },
    writeAudit: event => event.type !== 'file-effect',
  })
  assert.deepEqual(await start()(), { operation: 'modify', evidenceIncomplete: true, auditIncomplete: true })
  await assert.rejects(start()(), denied)
  assert.equal(observations.length, 1)
  assert.equal(fs.readFileSync(path, 'utf8'), 'updated')
})

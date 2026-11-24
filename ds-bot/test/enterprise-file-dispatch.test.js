import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkerFileDispatch } from '../src/host/enterprise/file-dispatch.js'
import { createWorkerFileEffects } from '../src/host/enterprise/file-effects.js'

const actor = { personId: 'alice', botId: 'helper', roomId: 'room', sessionId: 'session', requestId: 'request', dispatchId: 'call' }
const posix = { skip: process.platform === 'win32' }
const refused = { code: 'not-authorized' }

function fixture(t, judge, writeAudit) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'dsbot-file-dispatch-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'owned')
  mkdirSync(root, { mode: 0o700 })
  const path = join(root, 'notes')
  writeFileSync(path, 'initial')
  const { inspectVersion } = createWorkerFileEffects({ root, workerOwned: true, authorization: { consume: () => false } })
  const input = { operation: 'modify', path, version: inspectVersion(path), content: Buffer.from('approved') }
  const state = { live: true, version: 'rules-v1' }
  const calls = []
  const dispatch = createWorkerFileDispatch({ root, workerOwned: true, writeAudit,
    isAuthorized: scope => state.live && scope.personId === actor.personId && scope.sessionId === actor.sessionId,
    readRules: () => ({ version: state.version, rules: [{ id: 'notes', personId: actor.personId, roomId: actor.roomId,
      botId: actor.botId, directory: root, grant: 'write', effect: 'allow', purpose: 'Maintain notes' }] }),
    adjudicate(question) {
      calls.push(question)
      const allow = { verdict: 'allow', ruleId: question.rule.id, ruleVersion: question.rule.version, reason: 'Fits the purpose' }
      return judge ? judge(state, allow, path) : allow
    },
  })
  return { root, path, input, dispatch, calls }
}

test('composes one approved write and binds a private snapshot of the bytes', posix, async t => {
  const { dispatch, input, path, calls } = fixture(t, (_state, allow) => {
    input.content.fill(120)
    return allow
  })
  await assert.rejects(dispatch(actor, { ...input, personId: 'bob' }), refused)
  await assert.rejects(dispatch({ ...actor, roomId: 'foreign' }, input), refused)
  assert.deepEqual(calls, [])
  assert.deepEqual(await dispatch(actor, input), { operation: 'modify' })
  assert.equal(readFileSync(path, 'utf8'), 'approved')
  await assert.rejects(dispatch(actor, input), refused)
  assert.equal(calls.length, 1)
})

for (const [label, judge] of [
  ['denied judgment', (_state, allow) => ({ ...allow, verdict: 'deny' })],
  ['rule change', (state, allow) => { state.version = 'rules-v2'; return allow }],
  ['revocation', (state, allow) => { state.live = false; return allow }],
]) {
  test('preserves original bytes after ' + label, posix, async t => {
    const { dispatch, input, path, root } = fixture(t, judge)
    await assert.rejects(dispatch(actor, input), refused)
    assert.equal(readFileSync(path, 'utf8'), 'initial')
    assert.deepEqual(readdirSync(root), ['notes'])
  })
}

test('fails with a version conflict after a fixture update during adjudication', posix, async t => {
  const { dispatch, input, path } = fixture(t, (_state, allow, file) => {
    writeFileSync(file, 'new version')
    return allow
  })
  await assert.rejects(dispatch(actor, input), { code: 'version-conflict' })
  assert.equal(readFileSync(path, 'utf8'), 'new version')
})

const auditScope = { ...actor, operation: 'modify' }
const matchedRule = { ruleId: 'notes', ruleVersion: 'rules-v1' }
const authorizationEvent = (verdict, rule = matchedRule) => ({ type: 'file-authorization', ...auditScope, ...rule, verdict })
const effectEvent = outcome => ({ ...authorizationEvent('allowed'), type: 'file-effect', outcome })

test('audits denials with or without a matched rule and preserves file bytes', posix, async t => {
  const audit = []
  const { dispatch, input, path } = fixture(t, (_state, allow) => ({ ...allow, verdict: 'deny', reason: 'fixture private reason' }), event => audit.push(event))
  await assert.rejects(dispatch({ ...actor, personId: 'bob' }, input), refused)
  await assert.rejects(dispatch(actor, input), refused)
  assert.equal(readFileSync(path, 'utf8'), 'initial')
  assert.deepEqual(audit, [
    { ...authorizationEvent('denied', { ruleId: null, ruleVersion: null }), personId: 'bob' },
    authorizationEvent('denied'),
  ])
})

test('audits authorized write before execution and records completion after it', posix, async t => {
  const audit = []
  const { dispatch, input, path } = fixture(t, undefined, async event => {
    audit.push([event, readFileSync(path, 'utf8')])
  })
  assert.deepEqual(await dispatch(actor, input), { operation: 'modify' })
  assert.deepEqual(audit, [[authorizationEvent('allowed'), 'initial'], [effectEvent('completed'), 'approved']])
})

test('audits a failed effect and preserves the original error even when outcome logging fails', posix, async t => {
  const audit = []
  const { dispatch, input, path } = fixture(t, (_state, allow, file) => {
    writeFileSync(file, 'new version')
    return allow
  }, event => {
    audit.push(event)
    if (event.type === 'file-effect') throw new Error('fixture audit sink unavailable')
  })
  await assert.rejects(dispatch(actor, input), { code: 'version-conflict' })
  assert.deepEqual(audit, [authorizationEvent('allowed'), effectEvent('failed')])
  assert.equal(readFileSync(path, 'utf8'), 'new version')
})

test('failed pre-effect audit blocks modification and does not trigger execution', posix, async t => {
  const audit = []
  const { dispatch, input, path } = fixture(t, undefined, async event => {
    audit.push(event)
    return false
  })
  await assert.rejects(dispatch(actor, input), { code: 'file-audit-unavailable' })
  assert.equal(readFileSync(path, 'utf8'), 'initial')
  assert.deepEqual(audit, [authorizationEvent('allowed')])
})

test('post-commit audit failure returns a completed effect with an audit gap and does not replay', posix, async t => {
  const audit = []
  const { dispatch, input, path, calls } = fixture(t, undefined, async event => {
    audit.push(event)
    if (event.type === 'file-effect') throw new Error('fixture audit sink unavailable')
  })
  assert.deepEqual(await dispatch(actor, input), { operation: 'modify', auditIncomplete: true })
  assert.equal(readFileSync(path, 'utf8'), 'approved')
  assert.deepEqual(audit, [authorizationEvent('allowed'), effectEvent('completed')])
  await assert.rejects(dispatch(actor, input), refused)
  assert.equal(calls.length, 1)
})

test('revocation during a successful pre-effect audit still prevents the write', posix, async t => {
  let state
  const audit = []
  const { dispatch, input, path } = fixture(t, (current, allow) => { state = current; return allow }, async event => {
    audit.push(event)
    if (event.type === 'file-authorization') state.live = false
  })
  await assert.rejects(dispatch(actor, input), refused)
  assert.equal(readFileSync(path, 'utf8'), 'initial')
  assert.deepEqual(audit, [authorizationEvent('allowed'), effectEvent('failed')])
})

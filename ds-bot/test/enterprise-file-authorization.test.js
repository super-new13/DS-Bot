import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBusinessFileAuthorization } from '../src/host/enterprise/file-authorization.js'

const action = { personId: 'alice', botId: 'helper', roomId: 'design', sessionId: 'session-a',
  requestId: 'request-a', dispatchId: 'call-a', operation: 'modify', path: '/business/design/notes.txt',
  version: 'v1', contentDigest: 'a'.repeat(64) }
const allow = { id: 'write-design', personId: 'alice', botId: 'helper', roomId: 'design',
  directory: '/business/design', grant: 'write', effect: 'allow', purpose: 'Maintain design notes' }

function fixture(options) {
  const state = { time: 100, live: true, rules: [allow], version: 'rules-v1' }
  const auth = createBusinessFileAuthorization({ readRules: () => ({ rules: state.rules, version: state.version }),
    isAuthorized: () => state.live, now: () => state.time, ttlMs: 10, ...options })
  return { state, ...auth }
}

function approved(auth, input = action) {
  const decision = auth.prepare(input)
  assert.ok(decision)
  assert.equal(auth.decide(decision, 'allow'), true)
  return decision
}

test('matches exact actor, Bot, room, and canonical directory scope with read/write separation', () => {
  const auth = fixture()
  for (const patch of [{ personId: 'bob' }, { botId: 'other' }, { roomId: null }, { roomId: 'other' },
    { path: '/business/design-review/file.txt' }, { path: '/business/design/../file.txt' },
    { path: '/business/design' }, { path: '/business/design//notes.txt' }, { path: 'business/design/notes.txt' },
    { operation: 'delete' }, { version: null }, { contentDigest: 'malformed' }]) {
    assert.equal(auth.prepare({ ...action, ...patch }), undefined)
  }
  const read = { ...action, operation: 'read', contentDigest: null }
  assert.equal(auth.prepare(read), undefined)
  auth.state.rules = [{ ...allow, grant: 'read' }]
  assert.equal(auth.prepare(action), undefined)
  assert.equal(auth.consume(approved(auth, read), read), true)
  const creation = { ...action, dispatchId: 'new-call', operation: 'create', version: null }
  auth.state.rules = [allow]
  assert.equal(auth.consume(approved(auth, creation), creation), true)
})

test('selects equally scoped matches deterministically and lets a matching denial win', () => {
  const auth = fixture()
  const general = { ...allow, id: 'a-general', directory: '/business' }
  const specific = { ...allow, id: 'a-specific' }
  auth.state.rules = [allow, general, specific]
  assert.equal(auth.prepare(action).ruleId, 'a-specific')
  const second = { ...action, dispatchId: 'other-call' }
  auth.state.rules.reverse()
  assert.equal(auth.prepare(second).ruleId, 'a-specific')
  auth.state.rules.push({ ...general, id: 'lock-business', effect: 'deny' })
  assert.equal(auth.prepare({ ...action, dispatchId: 'denied-call' }), undefined)
})

test('expires decisions, bounds outstanding dispatches and rejects reuse', () => {
  const auth = fixture({ maxPending: 1 })
  const first = approved(auth)
  assert.equal(auth.consume(first, action), true)
  assert.equal(auth.consume(first, action), false)
  assert.equal(auth.decide(first, 'allow'), false)
  assert.equal(auth.prepare(action), undefined)
  const other = { ...action, dispatchId: 'other-call' }
  assert.equal(auth.prepare(other), undefined)
  auth.state.time += 10
  const second = approved(auth, other)
  auth.state.time += 10
  assert.equal(auth.consume(second, other), false)
  const pending = auth.prepare({ ...action, dispatchId: 'third-call' })
  auth.state.time += 10
  assert.equal(auth.decide(pending, 'allow'), false)
})

test('binds a decision to exact identity, dispatch, operation, path, version and content', () => {
  for (const patch of [{ personId: 'bob' }, { botId: 'other' }, { roomId: null }, { sessionId: 'other' },
    { requestId: 'other' }, { dispatchId: 'other' }, { operation: 'create', version: null },
    { path: '/business/design/other.txt' }, { version: 'v2' }, { contentDigest: 'b'.repeat(64) }]) {
    const auth = fixture()
    const decision = approved(auth)
    assert.equal(auth.consume({ ...decision }, action), false)
    assert.equal(auth.consume(decision, { ...action, ...patch }), false)
    assert.equal(auth.consume(decision, action), false)
  }
})

test('rechecks live authorization and rule contents both before approval and before use', () => {
  for (const mutate of [state => { state.live = false }, state => { state.version = 'rules-v2' },
    state => { state.rules = [{ ...allow, purpose: 'Changed purpose' }] }, state => { state.rules = [] }]) {
    const first = fixture()
    const pending = first.prepare(action)
    mutate(first.state)
    assert.equal(first.decide(pending, 'allow'), false)
    assert.equal(first.consume(pending, action), false)
    const second = fixture()
    const decision = approved(second)
    mutate(second.state)
    assert.equal(second.consume(decision, action), false)
  }
  const auth = fixture()
  const handle = auth.prepare(action)
  assert.equal(auth.decide(handle, 'unknown'), false)
  assert.equal(auth.decide(handle, 'allow'), false)
  assert.equal(auth.consume(handle, action), false)
})

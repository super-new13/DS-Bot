import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFileAdjudicator } from '../src/host/enterprise/file-adjudicator.js'
import { createBusinessFileAuthorization } from '../src/host/enterprise/file-authorization.js'

const operation = { personId: 'alice', botId: 'helper', roomId: null, sessionId: 'session-a', requestId: 'request-a',
  dispatchId: 'call-a', operation: 'modify', path: '/business/design/notes.txt', version: 'file-v1', contentDigest: 'a'.repeat(64) }
const rule = { id: 'notes', personId: 'alice', botId: 'helper', roomId: null, directory: '/business/design',
  grant: 'write', effect: 'allow', purpose: 'Maintain design notes' }
const allow = { verdict: 'allow', ruleId: rule.id, ruleVersion: 'rules-v1', reason: 'Fits the design-note purpose' }

function fixture(adjudicate, options) {
  const state = { version: 'rules-v1', rules: [rule], live: true, time: 100 }
  const authorization = createBusinessFileAuthorization({ readRules: () => state, isAuthorized: () => state.live,
    now: () => state.time, ttlMs: 50 })
  return { state, authorization, approve: createFileAdjudicator({ authorization, adjudicate, ...options }) }
}

test('matches deterministic scope before requesting a minimal judgment and grants one use', async () => {
  const seen = []
  const { approve, authorization, state } = fixture((question, { signal }) => {
    assert.equal(signal.aborted, false)
    seen.push(question)
    return allow
  })
  assert.equal(await approve({ ...operation, personId: 'outsider' }), undefined)
  assert.equal(await approve({ ...operation, path: '/business/outside.txt' }), undefined)
  state.rules = [rule, { ...rule, id: 'deny-notes', effect: 'deny' }]
  assert.equal(await approve(operation), undefined)
  assert.deepEqual(seen, [])
  state.rules = [rule]
  const decision = await approve(operation, { context: 'Update the meeting notes' })
  assert.deepEqual(seen, [{ rule: { id: rule.id, version: 'rules-v1', purpose: rule.purpose },
    action: { operation: 'modify', path: operation.path }, context: 'Update the meeting notes' }])
  assert.equal(authorization.consume(decision, operation), true)
  assert.equal(authorization.consume(decision, operation), false)
})

test('denies malformed, mismatched, non-allow or failed judgments', async () => {
  const invalid = [null, 'allow', { ...allow, verdict: 'deny' }, { ...allow, verdict: 'unknown' },
    { ...allow, verdict: 'ALLOW' }, { ...allow, ruleId: 'other' }, { ...allow, ruleVersion: 'old' },
    { ...allow, reason: '' }, { ...allow, reason: 'a'.repeat(513) }, { ...allow, extra: true },
    Object.defineProperty({ ...allow }, 'verdict', { get: () => 'allow' })]
  for (const value of invalid) {
    const { approve } = fixture(() => value)
    assert.equal(await approve(operation), undefined)
  }
  const { approve } = fixture(async () => { throw new Error('mock transport failure') })
  assert.equal(await approve(operation), undefined)
})

test('live grant changes and expiry while awaiting a valid verdict deny approval', async () => {
  for (const alter of [state => { state.live = false }, state => { state.version = 'rules-v2' },
    state => { state.rules = [{ ...rule, purpose: 'Updated purpose' }] }, state => { state.time = 150 }]) {
    const gate = Promise.withResolvers()
    const entered = Promise.withResolvers()
    const { approve, state } = fixture(() => { entered.resolve(); return gate.promise })
    const result = approve(operation)
    await entered.promise
    alter(state)
    gate.resolve(allow)
    assert.equal(await result, undefined)
  }
})

test('deadline aborts the injected adjudicator and ignores a late allow', { timeout: 2000 }, async () => {
  const gate = Promise.withResolvers()
  let signal
  const { approve } = fixture((_question, options) => { signal = options.signal; return gate.promise }, { timeoutMs: 10 })
  assert.equal(await approve(operation), undefined)
  assert.equal(signal.aborted, true)
  gate.resolve(allow)
  assert.equal(await approve(operation), undefined)
})

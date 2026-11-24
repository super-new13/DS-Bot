import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalService } from '@deepseek-ai/dsh-user-approval'

const name = 'record_fixture'
const callId = 'fixture-call'
const approvedArgs = Object.freeze({ item: 'example', value: 'approved text' })

async function probe(t, scenario) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  await ctx.plugin(ApprovalService, { policy: 'ask' })

  const trace = []
  const writes = []
  const dispatchScope = new AsyncLocalStorage()
  let ruleVersion = 1
  let dispatch
  let ask
  let body
  ctx.on('approval/request', async request => {
    trace.push('ask')
    ask = request
    const pending = dispatchScope.getStore()
    if (pending === undefined || request.agent !== pending.agent || request.toolName !== pending.toolName
        || request.callId === undefined || request.callId !== pending.callId || request.signal !== pending.signal
        || pending.arguments.item !== approvedArgs.item || pending.arguments.value !== approvedArgs.value) return 'rejected'
    if (scenario === 'rule changed') ruleVersion += 1
    return 'allowed-once'
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== name) return next()
    trace.push('dispatch')
    dispatch = exec
    const pending = {
      agent: exec.agent, toolName: exec.name, callId: exec.callId, arguments: exec.arguments,
      signal: exec.signal, token: exec.token, version: ruleVersion,
    }
    if (!pending.agent || !pending.callId || exec.parent !== undefined || exec.rootCallId !== exec.callId) {
      throw new Error('Unattributed dispatch')
    }
    const askedId = scenario === 'missing ID' ? undefined : scenario === 'different ID' ? 'other-call' : exec.callId
    const request = { agent: exec.agent, toolName: name, callId: askedId, signal: exec.signal }
    const askApproval = () => ctx.approval.request(request)
    const decision = await (scenario === 'unbound ask' ? askApproval() : dispatchScope.run(pending, askApproval))
    trace.push(decision)
    if (decision !== 'allowed-once' || pending.version !== ruleVersion || exec.signal.aborted
        || pending.token !== exec.token || pending.arguments !== exec.arguments) {
      throw new Error('Dispatch authorization refused')
    }
    return next()
  })
  ctx.tools.register({
    name,
    description: 'Record a value in the test fixture',
    parameters: {
      type: 'object', properties: { item: { type: 'string' }, value: { type: 'string' } }, required: ['item', 'value'],
    },
    output: { schema: { type: 'string' }, render: text => [{ type: 'text', text }] },
    execute: async (args, execution) => {
      trace.push('body')
      body = execution
      writes.push(args)
      return 'recorded'
    },
  })

  const args = scenario === 'different value' ? { ...approvedArgs, value: 'other text' } : approvedArgs
  let calls = 0
  class MockAdapter extends LlmAdapter {
    providerInfo() { return { id: 'mock', name: 'Mock' } }
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 }, defaultMaxTokens: 1000 }
    }
    async *stream() {
      if (calls++ === 0) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call', id: callId, name }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) } }
        yield { type: 'finish', reason: { kind: 'tool-use' } }
        return
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new MockAdapter())
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('approval-fixture'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'record a value' }] }))
  await agent.whenIdle()

  assert.equal(dispatch.agent, agent)
  assert.equal(dispatch.callId, callId)
  assert.equal(dispatch.rootCallId, callId)
  assert.deepEqual({ ...dispatch.arguments }, args)
  assert.ok(Object.isFrozen(dispatch.arguments))
  assert.equal(ask.agent, agent)
  assert.equal(ask.toolName, name)
  assert.equal(Object.hasOwn(ask, 'arguments'), false)
  const events = agent.session.snapshotEvents()
  const asked = events.find(event => event.type === 'approval/asked')
  const decided = events.find(event => event.type === 'approval/decided')
  const result = events.find(event => event.type === 'tool/result')
  assert.equal(asked.data.callId, ask.callId)
  assert.equal(asked.data.id, decided.data.id)
  assert.ok(asked.seq < decided.seq && decided.seq < result.seq)
  assert.equal(result.data.message.toolCallId, callId)
  return { trace, writes, dispatch, ask, body, decided: decided.data.outcome, result: result.data.message }
}

for (const scenario of ['matched', 'missing ID', 'different ID', 'unbound ask', 'different value', 'rule changed']) {
  test('worker dispatch approval: ' + scenario, { timeout: 8000 }, async t => {
    const { trace, writes, dispatch, ask, body, decided, result } = await probe(t, scenario)
    const executed = scenario === 'matched'
    const expectedDecision = executed || scenario === 'rule changed' ? 'allowed-once' : 'rejected'
    assert.equal(decided, expectedDecision)
    assert.deepEqual(trace, ['dispatch', 'ask', expectedDecision, ...(executed ? ['body'] : [])])
    assert.deepEqual(writes.map(args => ({ ...args })), executed ? [approvedArgs] : [])
    assert.equal(result.isError === true, !executed)
    if (executed) {
      assert.equal(body.token, dispatch.token)
      assert.equal(body.callId, ask.callId)
    }
  })
}

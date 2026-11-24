import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const validId = id => typeof id === 'string' && id.trim() !== ''
const denied = () => Object.assign(new Error('Worker session operation refused'), { code: 'not-authorized' })
const emptyInbox = agent => agent.inbox.nextStep.length === 0 && agent.inbox.nextTurn.length === 0

// Inputs come from the authenticated host adapter, including the synchronous
// current-authorization check. Mount in a dedicated DSH context with the worker
// tool boundary already configured. A room binding keeps the actor on the turn.
export function createWorkerSessionAdapter(ctx, { authorize, provider, model, nodeId, mapping, sessionRoot }) {
  if (typeof authorize !== 'function' || !validId(provider) || !validId(model)) {
    throw new TypeError('Worker requires authorization and an explicit model route')
  }
  const sessions = new Map()
  const reservedKeys = new Set()
  const openings = new Map()
  const handles = new Set()
  let closing = false

  function allowed(scope, requestId) {
    try { return !closing && authorize(scope, requestId) === true } catch { return false }
  }

  function canContinue(entry, run) {
    if (!live(entry) || run.revoked) return false
    if (allowed(run.scope, run.requestId)) return true
    run.revoked = true
    return false
  }

  function live(entry) {
    return !entry.tainted && ctx.agents.get(entry.scope.sessionId) === entry.agent
  }

  function actorScope(scope, personId) {
    return scope.roomId === undefined ? scope : Object.freeze({ ...scope, personId })
  }

  function owned({ sessionId, sessionKey, personId, botId, roomId, requestId }) {
    const entry = sessions.get(sessionId)
    if (!entry || !validId(personId) || entry.scope.sessionKey !== sessionKey || entry.scope.roomId !== roomId
        || (roomId === undefined && entry.scope.personId !== personId) || entry.scope.botId !== botId
        || !live(entry) || !allowed(actorScope(entry.scope, personId), roomId === undefined ? undefined : requestId)) throw denied()
    return entry
  }

  async function openDurable({ sessionKey, personId, botId, sessionId, roomId, requestId }) {
    const inRoom = roomId !== undefined
    if (!validId(personId) || (inRoom && (typeof roomId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(roomId)))
        || sessionKey !== JSON.stringify(inRoom ? ['room', nodeId, botId, roomId] : [nodeId, botId, personId])) throw denied()
    const authorized = scope => allowed(actorScope(scope, personId), inRoom ? requestId : undefined)
    const resultFor = scope => {
      const input = { ...actorScope(scope, personId), requestId }
      return actorScope(owned(input).scope, personId)
    }
    if (closing) throw denied()
    const pending = openings.get(sessionKey)
    if (pending) {
      const scope = await pending
      if (sessionId !== undefined && scope.sessionId !== sessionId) throw denied()
      return resultFor(scope)
    }
    const opening = (async () => {
      const binding = inRoom ? { roomId } : { personId }
      const owner = { nodeId, botId, ...binding }
      const saved = await mapping.lookup(owner)
      if (sessionId !== undefined && saved?.sessionId !== sessionId) throw denied()
      const scope = Object.freeze({ sessionKey, botId, ...binding, sessionId: saved?.sessionId ?? randomUUID() })
      if (!authorized(scope)) throw denied()
      if (sessions.has(scope.sessionId)) {
        resultFor(scope)
        return scope
      }
      const setup = (_agentCtx, agent) => ({ commit() {
        if (!authorized(scope) || agent.session.id !== scope.sessionId || !emptyInbox(agent)) throw denied()
      } })
      const agentOptions = { provider, model }
      const handle = saved
        ? await ctx.agents.resume({ resumeSessionId: scope.sessionId, agentOptions, setup })
        : await ctx.agents.create({ sessionId: scope.sessionId, agentOptions, meta: { cwd: sessionRoot }, setup })
      try {
        if (!saved) {
          await ctx.sessions.flush(handle.agent.session)
          if (!authorized(scope)) throw denied()
          await mapping.bind({ ...owner, sessionId: scope.sessionId })
        }
        if (!authorized(scope)) throw denied()
        handles.add(handle)
        sessions.set(scope.sessionId, { agent: handle.agent, scope, requests: new Set() })
        return scope
      } catch (error) {
        await handle.dispose()
        throw error
      }
    })()
    openings.set(sessionKey, opening)
    try { return resultFor(await opening) } finally { openings.delete(sessionKey) }
  }

  async function create({ sessionKey, personId, botId, roomId }) {
    if (mapping) return openDurable({ sessionKey, personId, botId, roomId })
    if (roomId !== undefined) throw denied()
    if (![sessionKey, personId, botId].every(validId)) throw denied()
    if (reservedKeys.has(sessionKey)) throw denied()
    const scope = Object.freeze({ sessionKey, personId, botId, sessionId: randomUUID() })
    if (!allowed(scope)) throw denied()
    reservedKeys.add(sessionKey)
    try {
      const handle = await ctx.agents.create({ sessionId: scope.sessionId, agentOptions: { provider, model } })
      if (handle.agent.session.id !== scope.sessionId || !allowed(scope)) {
        await handle.dispose()
        throw denied()
      }
      sessions.set(scope.sessionId, { agent: handle.agent, scope, requests: new Set() })
      return scope
    } catch (error) {
      reservedKeys.delete(sessionKey)
      throw error
    }
  }

  function emit(entry, run, fields) {
    if (!canContinue(entry, run)) return
    const { sessionId } = entry.scope
    const { roomId, personId } = run.scope
    const actor = roomId === undefined ? {} : { roomId, personId }
    try { run.onEvent(Object.freeze({ sessionId, requestId: run.requestId, ...actor, ...fields })) } catch {
      // A consuming callback cannot disrupt DSH execution.
    }
  }

  ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next) => {
    const entry = sessions.get(agent.session.id)
    if (!entry) return next()
    const run = entry.active
    const match = inputs => run !== undefined && (run.turn === undefined
      ? inputs.length === 1 && inputs[0].id === run.messageId
      : run.turn === turn && inputs.length === 0)
    if (entry.agent !== agent || !live(entry)) return { kind: 'reject' }
    if (!match(messages)) {
      entry.tainted = true
      return { kind: 'reject' }
    }
    if (!canContinue(entry, run)) return { kind: 'reject' }
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (entry.active !== run || !canContinue(entry, run)) return { kind: 'reject' }
    if (!match(decision.messages)) {
      entry.tainted = true
      return { kind: 'reject' }
    }
    run.turn = turn
    run.step = step
    run.attempt = undefined
    return decision
  })

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const entry = sessions.get(agent.session.id)
    const run = entry?.active
    if (entry?.agent !== agent || !run?.admitted || run.status !== undefined) return
    if (frame.type === 'start' && frame.turn === run.turn && frame.step === run.step) {
      run.attempt = frame.attemptId
    } else if (frame.type === 'chunk' && frame.attemptId === run.attempt && frame.chunk.type === 'text-delta') {
      emit(entry, run, { type: 'delta', text: frame.chunk.text })
    }
  })

  ctx.on('session/event', (session, event) => {
    const entry = sessions.get(session.id)
    if (entry?.agent.session !== session) return
    const run = entry.active
    if (event.type === 'user/message') {
      if (run?.turn !== undefined && event.data.id === run.messageId) run.admitted = true
      else entry.tainted = true
    }
    if (!run?.admitted || event.data?.turn !== run.turn || run.status !== undefined) return
    if (event.type === 'assistant/message' && !event.data.interrupted) {
      const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      if (text !== '') emit(entry, run, { type: 'reply', text, seq: event.seq })
    } else if (event.type === 'turn/end') {
      const kind = event.data.reason.kind
      run.status = kind === 'completed' || kind === 'aborted' ? kind : 'failed'
    }
  })

  async function submit(input, onEvent = () => {}) {
    const { requestId, text } = input
    if (!validId(requestId) || !validId(text) || typeof onEvent !== 'function') throw new TypeError('Invalid worker submission')
    if (!validId(input.sessionId)) throw denied()
    if (mapping && !sessions.has(input.sessionId)) await openDurable(input)
    const entry = owned(input)
    const { agent, scope } = entry
    if (entry.active || entry.requests.has(requestId) || agent.status !== 'idle' || !emptyInbox(agent)) throw denied()
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
    const run = { requestId, scope: actorScope(scope, input.personId), messageId: message.id, onEvent }
    if (!canContinue(entry, run)) throw denied()
    entry.requests.add(requestId)
    entry.active = run
    try {
      agent.followup(message)
      await agent.whenIdle()
      if (mapping) await ctx.sessions.flush(agent.session)
      if (!canContinue(entry, run)) throw denied()
      const status = run.status ?? 'failed'
      emit(entry, run, { type: 'done', status })
      return { sessionId: scope.sessionId, requestId, status }
    } finally {
      entry.active = undefined
    }
  }

  function cancel(input) {
    const entry = owned(input)
    const run = entry.active
    if (!run?.admitted || run.requestId !== input.requestId || run.scope.personId !== input.personId || run.status !== undefined
        || run.cancelRequested || entry.agent.status !== 'running' || !emptyInbox(entry.agent)
        || !canContinue(entry, run)) throw denied()
    run.cancelRequested = true
    entry.agent.cancel({ kind: 'hook', reason: 'ds-bot/enterprise-worker-stop' }, { keepInbox: true })
    return { accepted: true }
  }

  async function close() {
    closing = true
    await Promise.allSettled(openings.values())
    const results = await Promise.allSettled(Array.from(handles, handle => handle.dispose()))
    const failed = results.find(result => result.status === 'rejected')
    if (failed) throw failed.reason
  }

  return { create, submit, cancel, close }
}

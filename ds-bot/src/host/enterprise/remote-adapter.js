const unknownCode = 'worker-outcome-unknown'
const terminal = new Set(['aborted', 'completed', 'failed'])
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const denied = () => Object.assign(new Error('Worker scope refused'), { code: 'not-authorized' })
const unknown = () => Object.assign(new Error('Worker outcome unknown'), { code: unknownCode })
const matchesScope = (value, scope) => value && Object.keys(scope).every(key => !Object.hasOwn(value, key) || value[key] === scope[key])

async function remote(call) {
  try {
    return await call()
  } catch (error) {
    if (error?.code === 'worker-refused') throw denied()
    throw unknown()
  }
}

export function createRemoteWorkerAdapter({ client, nodeId }) {
  if (!validId(nodeId) || ['create', 'submit', 'cancel'].some(key => typeof client?.[key] !== 'function')) {
    throw new TypeError('Expected a scoped remote worker client')
  }
  const sessions = new Map()
  const owners = new Map()
  const active = new Map()

  async function create({ sessionKey, personId, botId }) {
    if (!validId(personId) || !validId(botId) || sessionKey !== JSON.stringify([personId, botId])) throw denied()
    if (!sessions.has(sessionKey)) {
      const scope = Object.freeze({ nodeId, personId, botId })
      const opening = remote(() => client.create(scope)).then(result => {
        if (!matchesScope(result, scope) || !validId(result.sessionId) || owners.has(result.sessionId)) throw unknown()
        owners.set(result.sessionId, sessionKey)
        return Object.freeze({ ...scope, sessionKey, sessionId: result.sessionId })
      })
      // Keep an uncertain create bound to its key until the host reconciles it.
      sessions.set(sessionKey, opening)
    }
    return sessions.get(sessionKey)
  }

  function bound({ sessionKey, sessionId, personId, botId, nodeId: requestedNode, requestId }) {
    if (requestedNode !== nodeId || !validId(requestId) || owners.get(sessionId) !== sessionKey
        || !validId(personId) || !validId(botId) || sessionKey !== JSON.stringify([personId, botId])) throw denied()
    return Object.freeze({ nodeId, personId, botId, sessionId })
  }

  async function submit(input, onEvent = () => {}) {
    const scope = bound(input)
    const { requestId, text } = input
    if (active.has(scope.sessionId) || typeof text !== 'string' || !text.trim()) throw denied()
    active.set(scope.sessionId, requestId)
    try {
      const result = await remote(() => client.submit(scope, requestId, text, { onEvent(event) {
        if (active.get(scope.sessionId) === requestId && event?.requestId === requestId && matchesScope(event, scope)
            && ['delta', 'reply'].includes(event.type) && typeof event.text === 'string') {
          onEvent({ type: event.type, requestId, sessionId: scope.sessionId, text: event.text })
        }
      } }))
      const status = result?.requestId === requestId && matchesScope(result, scope) && terminal.has(result.status)
        ? result.status : 'unknown'
      return { requestId, sessionId: scope.sessionId, status }
    } finally {
      active.delete(scope.sessionId)
    }
  }

  async function cancel(input) {
    const scope = bound(input)
    const { requestId } = input
    if (active.get(scope.sessionId) !== requestId) throw denied()
    const result = await remote(() => client.cancel(scope, requestId))
    if (result?.accepted !== true || !matchesScope(result, { ...scope, requestId })) throw unknown()
    return { accepted: true }
  }

  return { create, submit, cancel }
}

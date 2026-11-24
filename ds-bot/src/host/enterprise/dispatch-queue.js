function countByKey(map, key, delta) {
  const count = (map.get(key) ?? 0) + delta
  if (count === 0) map.delete(key)
  else map.set(key, count)
}

function dispatchError(code, message) {
  return Object.assign(new Error(message), { code })
}

// Accept only server-resolved routing and identity. sessionKey must identify the
// logical conversation across DSH segments. Treat any nested payload as immutable.
// authorize must read current permissions and return true to permit execution.
// execute must settle only once the request has stopped using the session and quota.
export function createDispatchQueue({ maxActive, maxPerBot, maxPerNode, maxPending, authorize, execute }) {
  for (const [name, value] of Object.entries({ maxActive, maxPerBot, maxPerNode, maxPending })) {
    if (!Number.isSafeInteger(value) || value < (name === 'maxPending' ? 0 : 1)) {
      throw new RangeError('Invalid dispatch limit: ' + name)
    }
  }
  if (typeof authorize !== 'function' || typeof execute !== 'function') {
    throw new TypeError('Dispatch requires authorize and execute callbacks')
  }

  const pending = []
  const sessions = new Set()
  const bots = new Map()
  const nodes = new Map()

  function hasCapacity({ sessionKey, botId, nodeId }) {
    return sessions.size < maxActive && !sessions.has(sessionKey)
      && (bots.get(botId) ?? 0) < maxPerBot && (nodes.get(nodeId) ?? 0) < maxPerNode
  }

  function drain() {
    const blockedSessions = new Set()
    for (let i = 0; i < pending.length && sessions.size < maxActive;) {
      const entry = pending[i]
      const { sessionKey } = entry.request
      if (blockedSessions.has(sessionKey) || !hasCapacity(entry.request)) {
        blockedSessions.add(sessionKey)
        i++
      } else {
        pending.splice(i, 1)
        start(entry)
      }
    }
  }

  function start({ request, resolve, reject }) {
    const { sessionKey, botId, nodeId } = request
    sessions.add(sessionKey)
    countByKey(bots, botId, 1)
    countByKey(nodes, nodeId, 1)
    // Reserve capacity before calling injected code, including synchronous callbacks.
    Promise.resolve().then(async () => {
      try {
        if (await authorize(request) !== true) {
          throw dispatchError('not-authorized', 'Dispatch authorization denied')
        }
        resolve(await execute(request))
      } catch (error) {
        reject(error)
      } finally {
        sessions.delete(sessionKey)
        countByKey(bots, botId, -1)
        countByKey(nodes, nodeId, -1)
        drain()
      }
    })
  }

  async function enqueue(input) {
    const request = Object.freeze({ ...input })
    for (const key of ['requestId', 'sessionKey', 'personId', 'botId', 'nodeId']) {
      if (!Object.hasOwn(request, key) || typeof request[key] !== 'string' || request[key].trim() === '') {
        throw new TypeError('Invalid dispatch request field: ' + key)
      }
    }
    const startNow = hasCapacity(request) && !pending.some(entry => entry.request.sessionKey === request.sessionKey)
    if (!startNow && pending.length >= maxPending) {
      throw dispatchError('queue-full', 'Dispatch queue is full')
    }
    const { promise, resolve, reject } = Promise.withResolvers()
    const entry = { request, resolve, reject }
    if (startNow) start(entry)
    else pending.push(entry)
    return promise
  }

  return { enqueue }
}

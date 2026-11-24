const fields = ['nodeId', 'personId', 'botId', 'roomId', 'sessionId', 'requestId', 'dispatchId',
  'operation', 'targetId', 'version', 'contentDigest', 'ruleId', 'ruleVersion']
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
const operations = new Set(['read', 'create', 'modify'])
const terminal = new Set(['completed', 'cancelled', 'fenced'])
const denied = () => Object.assign(new Error('File reservation refused'), { code: 'not-authorized' })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function scopeOf(input) {
  if (!record(input) || Object.keys(input).length !== fields.length || !fields.every(field => Object.hasOwn(input, field))) throw denied()
  const scope = Object.freeze(Object.fromEntries(fields.map(field => [field, input[field]])))
  const { roomId, operation, version, contentDigest } = scope
  if (!operations.has(operation) || !(roomId === null || id(roomId))
      || !(operation === 'create' ? version === null : typeof version === 'string' && version.length <= 512 && version.trim() !== '')
      || !(operation === 'read' ? contentDigest === null : typeof contentDigest === 'string' && /^[a-f0-9]{64}$/.test(contentDigest))
      || !fields.slice(0, 7).filter(field => field !== 'roomId').every(field => id(scope[field]))
      || ![scope.targetId, scope.ruleId, scope.ruleVersion].every(id)) throw denied()
  return scope
}

const keyOf = scope => JSON.stringify([scope.nodeId, scope.requestId, scope.dispatchId])
const sameScope = (left, right) => fields.every(field => left[field] === right[field])

function checkState(state) {
  if (!record(state) || state.version !== 1 || !record(state.revocations) || !record(state.reservations)) throw denied()
  for (const [key, value] of Object.entries(state.revocations)) {
    if (!id(key) || value !== true) throw denied()
  }
  for (const [key, entry] of Object.entries(state.reservations)) {
    if (!record(entry) || keyOf(scopeOf(entry.scope)) !== key || (entry.status !== 'reserved' && !terminal.has(entry.status))) throw denied()
  }
}

function revocation(state, personId) {
  if (!Object.hasOwn(state.revocations, personId)) return 'active'
  return Object.values(state.reservations).some(entry => entry.scope.personId === personId && entry.status === 'reserved')
    ? 'pending' : 'revoked'
}

// The store commits serialized synchronous transactions over { version: 1,
// revocations: {}, reservations: {} }. The caller authenticates the node and
// verifies settlement evidence before calling settle. A timeout is not evidence.
export function createFileReservations({ transact, canReserve }) {
  if (typeof transact !== 'function' || typeof canReserve !== 'function') throw new TypeError('File reservations require transactions and live authorization')

  function update(change) {
    return transact(state => {
      checkState(state)
      return change(state)
    })
  }

  function reserve(input) {
    const scope = scopeOf(input)
    return update(state => {
      const key = keyOf(scope)
      if (Object.hasOwn(state.reservations, key)) {
        const previous = state.reservations[key]
        if (!sameScope(previous.scope, scope)) throw denied()
        return { issued: false, status: previous.status }
      }
      if (Object.hasOwn(state.revocations, scope.personId) || canReserve(scope) !== true) throw denied()
      state.reservations[key] = { scope: { ...scope }, status: 'reserved' }
      return { issued: true, status: 'reserved' }
    })
  }

  function revoke(personId) {
    if (!id(personId)) throw denied()
    return update(state => {
      Object.defineProperty(state.revocations, personId, { value: true, enumerable: true, configurable: true })
      return revocation(state, personId)
    })
  }

  function settle(input, status) {
    const scope = scopeOf(input)
    if (!terminal.has(status)) throw denied()
    return update(state => {
      const entry = state.reservations[keyOf(scope)]
      if (!entry || !sameScope(entry.scope, scope) || (entry.status !== 'reserved' && entry.status !== status)) throw denied()
      entry.status = status
      return revocation(state, scope.personId)
    })
  }

  return { reserve, revoke, settle }
}

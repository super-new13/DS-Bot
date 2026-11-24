import { canAccessEmployeeRoom, canAccessEmployeeSession } from './authorization.js'

const validId = value => typeof value === 'string' && value.trim() !== ''
const roomEvents = new Set(['message', 'group', 'room', 'done'])
const actorEvents = new Set(['question', 'approval'])

function employeeIdentity(context) {
  const { personId, loginSessionId } = context ?? {}
  if (!validId(personId) || !validId(loginSessionId)) return undefined
  return Object.freeze({ personId, loginSessionId })
}

// Callers supply server-resolved login context and authoritative event metadata.
// readRoster and resolveSession are synchronous so neither can yield after the session recheck.
export function createEmployeeGroupAccess({ readRoster, isSessionActive, resolveSession }) {
  const admitted = new WeakSet()

  async function inRoom(identity, roomId, check) {
    if (!identity || !validId(roomId)) return undefined
    try {
      if (await isSessionActive(identity) !== true) return undefined
      const state = readRoster()
      if (!canAccessEmployeeRoom(state, identity.personId, roomId)) return undefined
      return check(state)
    } catch {
      return undefined
    }
  }

  async function canReadRoom(context, roomId) {
    return await inRoom(employeeIdentity(context), roomId, () => true) === true
  }

  async function admitMessage(context, payload) {
    const identity = employeeIdentity(context)
    const { roomId, requestId, text } = payload ?? {}
    if (!validId(requestId) || typeof text !== 'string' || text.trim() === '') return undefined
    return inRoom(identity, roomId, state => {
      const name = state.people[identity.personId].name
      if (!validId(name)) return undefined
      const source = Object.freeze({ by: identity.personId, name, via: 'DS Bot web' })
      const message = Object.freeze({ roomId, requestId, text, source, identity })
      admitted.add(message)
      return message
    })
  }

  async function canExecuteMessage(message, roomId) {
    if (!admitted.has(message) || roomId !== message.roomId) return false
    return await inRoom(message.identity, message.roomId, () => true) === true
  }

  // Pass only server-classified group events here. The caller separately projects the
  // payload for employees. Private cards require the original, unambiguous submission.
  async function canReadEvent(context, subscribedRoomId, event) {
    const identity = employeeIdentity(context)
    const { type, roomId, sessionId, requestId, origin } = event ?? {}
    if (!identity || roomId !== subscribedRoomId) return false
    if (actorEvents.has(type)) {
      if (!admitted.has(origin) || origin.roomId !== roomId || origin.requestId !== requestId
        || origin.source.by !== identity.personId) return false
    } else if (!roomEvents.has(type)) return false

    return await inRoom(identity, roomId, state => {
      if (sessionId === undefined) return true
      if (!validId(sessionId)) return false
      const resolved = resolveSession(sessionId)
      return resolved?.kind === 'room' && resolved.roomId === roomId
        && canAccessEmployeeSession(state, identity.personId, sessionId, resolved)
    }) === true
  }

  return { canReadRoom, admitMessage, canExecuteMessage, canReadEvent }
}

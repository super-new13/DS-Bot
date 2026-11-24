const validId = id => typeof id === 'string' && id.trim() !== ''

function recordOf(records, id) {
  if (!validId(id) || !records || !Object.hasOwn(records, id)) return undefined
  const record = records[id]
  return record?.id === id ? record : undefined
}

function activePerson(state, personId) {
  const person = recordOf(state?.people, personId)
  return person?.revokedAt === undefined ? person : undefined
}

// Use current server-side records and a personId from authenticated host context.
export function canAccessEmployeeBot(state, personId, botId) {
  const person = activePerson(state, personId)
  const bot = recordOf(state?.bots, botId)
  return Boolean(bot && (bot.private === undefined || bot.private === false)
    && Array.isArray(person?.botIds) && person.botIds.includes(botId))
}

export function canAccessEmployeeRoom(state, personId, roomId) {
  const room = recordOf(state?.rooms, roomId)
  return Boolean(activePerson(state, personId) && Array.isArray(room?.people) && room.people.includes(personId))
}

// The caller must resolve the exact session (including old segments) from authoritative
// host metadata. Its scope and owner must never be supplied by the request body.
export function canAccessEmployeeSession(state, personId, sessionId, resolved) {
  if (!validId(sessionId) || resolved?.sessionId !== sessionId) return false
  if (resolved.kind === 'private') {
    return resolved.personId === personId && canAccessEmployeeBot(state, personId, resolved.botId)
  }
  if (resolved.kind === 'room') return canAccessEmployeeRoom(state, personId, resolved.roomId)
  return false
}

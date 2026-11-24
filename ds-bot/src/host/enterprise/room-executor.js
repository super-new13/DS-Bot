const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const maxReplyBytes = 64 * 1024

function refused() {
  return Object.assign(new Error('Room worker scope refused'), { code: 'not-authorized' })
}

export function createRoomExecutor({ roster, roomBots, clients }) {
  if (!roomBots || typeof roomBots !== 'object' || Array.isArray(roomBots)
      || Object.keys(roomBots).length !== Object.keys(roster.rooms).length) {
    throw new TypeError('Expected configured room worker routes')
  }
  const routes = new Map()
  for (const [roomId, room] of Object.entries(roster.rooms)) {
    const botId = Object.hasOwn(roomBots, roomId) ? roomBots[roomId] : undefined
    const bot = id(botId) ? roster.bots[botId] : undefined
    const client = clients.get(bot?.nodeId)
    // A single-Bot room needs no public Bot selection policy.
    if (room.members.length !== 1 || room.members[0] !== botId || !bot || bot.private || !client) {
      throw new TypeError('Expected a single configured worker Bot per room')
    }
    routes.set(roomId, { nodeId: bot.nodeId, botId, client, people: new Set(room.people) })
  }

  return async ({ roomId, requestId, text, source }) => {
    const route = routes.get(roomId)
    const personId = source?.by
    const person = roster.people[personId]
    if (!route?.people.has(personId) || !person || person.revokedAt !== undefined || person.name !== source.name
        || !id(requestId) || typeof text !== 'string' || !text.trim()) throw refused()
    const { nodeId, botId, client } = route
    const scope = { nodeId, botId, roomId, personId }
    // Resolve on each turn so the worker checks the originating actor on create and submit.
    const { sessionId } = await client.create(scope)
    let bytes = 0
    let overflow = false
    const replies = []
    const outcome = await client.submit({ ...scope, sessionId }, requestId, text, {
      onEvent(event) {
        if (event.type !== 'reply' || event.requestId !== requestId || overflow || !event.text) return
        bytes += Buffer.byteLength(event.text) + (replies.length ? 1 : 0)
        if (bytes > maxReplyBytes) {
          overflow = true
          replies.length = 0
        } else replies.push(event.text)
      },
    })
    if (outcome?.requestId !== requestId || !['completed', 'aborted', 'failed'].includes(outcome.status)) {
      throw Object.assign(new Error('Room worker outcome unknown'), { code: 'worker-outcome-unknown' })
    }
    if (overflow || outcome.status !== 'completed') return undefined
    const reply = replies.join(String.fromCharCode(10))
    if (reply.trim()) return { roomId, by: botId, name: botId, text: reply }
  }
}

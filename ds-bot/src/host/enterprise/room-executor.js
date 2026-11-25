import { dispatchRoomOpening } from './room-dispatch.js'

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const maxReplyBytes = 64 * 1024
const defaultWorkerBodyBytes = 16 * 1024

function roundText(scope, requestId, text, actorName, earlier) {
  const base = '[Message from ' + actorName + ' via DS Bot web]\n' + text
  const fits = value => Buffer.byteLength(JSON.stringify({ ...scope, requestId, text: value })) <= defaultWorkerBodyBytes
  if (!fits(base)) return text
  if (!earlier.length) return base
  const context = base + '\nEarlier replies in this round:'
  const excerpts = earlier.map(reply => '\n' + reply.name + ': ' + reply.text)
  const full = context + excerpts.join('')
  if (fits(full)) return full
  // Preserve the employee message when the preceding replies exceed the wire budget.
  const omitted = '\n[Earlier replies truncated]'
  let prompt = context
  for (const excerpt of excerpts) {
    if (!fits(prompt + excerpt + omitted)) break
    prompt += excerpt
  }
  return fits(prompt + omitted) ? prompt + omitted : base
}

function refused() {
  return Object.assign(new Error('Room worker scope refused'), { code: 'not-authorized' })
}

export function createRoomExecutor({ roster, roomBots, clients, readRoster = () => roster }) {
  if (!roomBots || typeof roomBots !== 'object' || Array.isArray(roomBots)
      || Object.keys(roomBots).length !== Object.keys(roster.rooms).length) {
    throw new TypeError('Expected configured room worker routes')
  }
  const routes = new Map()
  for (const [roomId, room] of Object.entries(roster.rooms)) {
    const configured = Object.hasOwn(roomBots, roomId) ? roomBots[roomId] : undefined
    const multi = Array.isArray(configured)
    const ids = multi ? configured : [configured]
    if (!ids.length || ids.length !== room.members.length || new Set(ids).size !== ids.length
        || !ids.every(botId => id(botId) && room.members.includes(botId) && roster.bots[botId]
          && !roster.bots[botId].private && clients.has(roster.bots[botId].nodeId))) {
      throw new TypeError(multi ? 'Expected configured worker routes for every room Bot' : 'Expected a single configured worker Bot per room')
    }
    routes.set(roomId, { ids: new Set(ids), multi })
  }

  async function send({ nodeId, id: botId, name = botId }, { roomId, personId, requestId, text, actorName, earlier }, authorize) {
    const client = clients.get(nodeId)
    const scope = Object.freeze({ nodeId, botId, roomId, personId })
    // Resolve on each turn so the worker checks the originating actor on create and submit.
    const { sessionId } = await client.create(scope)
    if (!await authorize()) return undefined
    let bytes = 0
    let overflow = false
    const replies = []
    const nativeScope = { ...scope, sessionId }
    const prompt = earlier ? roundText(nativeScope, requestId, text, actorName, earlier) : text
    const outcome = await client.submit(nativeScope, requestId, prompt, {
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
    if (reply.trim()) return { roomId, by: botId, name, text: reply }
  }

  return async ({ roomId, requestId, text, source, opener }, { authorize, publish } = {}) => {
    const route = routes.get(roomId)
    const { by: personId, name: actorName } = source ?? {}
    function current() {
      const live = readRoster()
      const person = Object.hasOwn(live.people, personId ?? '') ? live.people[personId] : undefined
      const room = Object.hasOwn(live.rooms, roomId) ? live.rooms[roomId] : undefined
      if (!route || !room?.people.includes(personId) || !person || person.revokedAt !== undefined || person.name !== actorName) return undefined
      return { room, bots: live.bots }
    }
    const live = current()
    if (!live || !id(requestId) || typeof text !== 'string' || !text.trim()) throw refused()
    const members = live.room.members.map(id => ({ ...live.bots[id], id })).filter(bot =>
      route.ids.has(bot.id) && !bot.private && clients.has(bot.nodeId))
    const permitted = async bot => {
      if (authorize && !await authorize()) return false
      const latest = current()
      return latest?.room.members.includes(bot.id) && latest.bots[bot.id]?.private !== true
        && latest.bots[bot.id]?.nodeId === bot.nodeId && clients.has(bot.nodeId)
    }
    if (!route.multi) {
      const bot = members[0]
      if (!bot || !await permitted(bot)) throw refused()
      return send(bot, { roomId, personId, requestId, text }, () => permitted(bot))
    }
    if (typeof authorize !== 'function' || typeof publish !== 'function') throw refused()
    return dispatchRoomOpening({ members, room: { mode: 'admin', ...live.room, id: roomId }, opener: { ...opener, text }, requestId,
      authorize: permitted, publish,
      send(bot, dispatchId, earlier, recheck) {
        return send(bot, { roomId, personId, requestId: dispatchId, text, actorName, earlier }, recheck)
      },
    })
  }
}

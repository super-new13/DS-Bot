import { createHash } from 'node:crypto'
import { selectRoomOpening } from '../room-opening.js'
import { mentionSpans } from '../../shared/mentions.js'

export async function dispatchRoomOpening({ members, room, opener, requestId, authorize, send, publish }) {
  const { speakers, ordered } = selectRoomOpening({ members, adminId: room.admin, mode: room.mode, opener }, () => {
    const spans = mentionSpans(opener.text, members)
    return { all: spans.some(span => span.all), found: [...new Set(spans.flatMap(span => span.bot ? [span.bot] : []))] }
  })
  const earlier = []
  async function run(bot) {
    if (!await authorize(bot)) return
    const dispatchId = createHash('sha256').update(JSON.stringify([room.id, requestId, bot.id])).digest('hex')
    const reply = await send(bot, dispatchId, [...earlier], () => authorize(bot))
    if (reply) {
      await publish(reply)
      if (ordered) earlier.push(reply)
    }
  }
  if (ordered) {
    for (const bot of speakers) await run(bot)
  } else {
    const results = await Promise.allSettled(speakers.map(run))
    const failure = results.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
  }
}

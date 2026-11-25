const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const text = value => typeof value === 'string' && value.trim() !== ''
const limit = value => Number.isSafeInteger(value) && value > 0

function project(row, roomId) {
  if (row?.roomId !== roomId || !['user', 'bot'].includes(row.kind)
      || !text(row.text) || !id(row.by) || !text(row.name)) throw new Error('Invalid scoped room transcript')
  return { roomId, kind: row.kind, text: row.text, by: row.by, name: row.name }
}

// Storage owns atomic append and a bounded tail read by exact room ID. Use one
// runtime per room namespace. The handler checks live access before and after
// history reads and authorizes each queued message through its dispatch callback.
export function createEmployeeGroupRuntime({ store, execute, openingRounds = false, maxActive = 4, maxPending = 32, maxPendingPerRoom = 8 }) {
  if (typeof store?.readTail !== 'function' || typeof store.append !== 'function' || typeof execute !== 'function'
      || ![maxActive, maxPending, maxPendingPerRoom].every(limit)) throw new TypeError('Invalid employee group runtime configuration')
  const pending = []
  const active = new Set()
  const requestIds = new Set()
  const usesOpeningRounds = typeof openingRounds === 'function' ? openingRounds : () => openingRounds

  async function readHistory({ roomId, limit: count = 100, signal }) {
    if (!id(roomId) || !limit(count)) throw new TypeError('Invalid room history request')
    signal?.throwIfAborted()
    const size = Math.min(count, 100)
    const rows = await store.readTail(roomId, { limit: size, signal })
    signal?.throwIfAborted()
    if (!Array.isArray(rows) || rows.length > size) throw new Error('Invalid scoped room transcript')
    return { roomId, messages: rows.map(row => project(row, roomId)) }
  }

  async function run({ message, dispatch }) {
    const { roomId, requestId } = message
    await dispatch(async (admitted, authorize) => {
      if (admitted !== message) throw new Error('Unexpected group dispatch identity')
      const { by, name } = admitted.source
      const rows = [project({ roomId, kind: 'user', text: admitted.text, by, name }, roomId)]
      const input = Object.freeze({ roomId, requestId, text: admitted.text, source: Object.freeze({ ...admitted.source }) })
      if (usesOpeningRounds(roomId)) {
        if (typeof authorize !== 'function' || !await authorize()) return
        const { appended } = await store.append(roomId, { requestId, rows })
        if (!appended) return
        const publish = reply => {
          const row = project({ ...reply, kind: 'bot' }, roomId)
          return store.append(roomId, { requestId, replyId: row.by, rows: [row] })
        }
        const reply = await execute(input, { authorize, publish })
        if (reply !== undefined) await publish(reply)
        return
      }
      try {
        const reply = await execute(input)
        if (reply !== undefined) rows.push(project({ ...reply, kind: 'bot' }, roomId))
      } finally {
        await store.append(roomId, { requestId, rows })
      }
    })
  }

  function drain() {
    for (let index = 0; index < pending.length && active.size < maxActive;) {
      const job = pending[index]
      const { roomId, requestId } = job.message
      if (active.has(roomId)) { index += 1; continue }
      pending.splice(index, 1)
      active.add(roomId)
      // A failed dispatch or commit must release capacity for later requests.
      void run(job).catch(() => {}).finally(() => {
        active.delete(roomId)
        requestIds.delete(requestId)
        drain()
      })
    }
  }

  function enqueue(message, dispatch) {
    if (!id(message?.roomId) || !id(message?.requestId) || !text(message.text)
        || !id(message.source?.by) || !text(message.source?.name) || typeof dispatch !== 'function'
        || requestIds.has(message.requestId)) return false
    const roomPending = pending.filter(job => job.message.roomId === message.roomId).length
    if (usesOpeningRounds(message.roomId) && (active.has(message.roomId) || roomPending > 0)) {
      throw Object.assign(new Error('Room round in progress'), { code: 'room-round-in-progress' })
    }
    const startsNow = !active.has(message.roomId) && roomPending === 0 && active.size < maxActive
    if (!startsNow && (pending.length >= maxPending || roomPending >= maxPendingPerRoom)) return false
    requestIds.add(message.requestId)
    pending.push({ message, dispatch })
    drain()
    return true
  }

  return { readHistory, enqueue }
}

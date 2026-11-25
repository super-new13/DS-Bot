import { randomUUID } from 'node:crypto'
import { canAccessEmployeeRoom } from './authorization.js'
import { createEmployeeGroupAccess } from './group-access.js'

const route = /^\/api\/enterprise\/group-chat\/([A-Za-z0-9_-]{1,128})\/(history|send)$/
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
const error = (status, message, extra) => Response.json({ error: message }, { status, headers: { ...headers, ...extra } })
const refused = () => error(403, 'Chat request refused')
const invalid = () => error(400, 'Invalid chat request')
const unavailable = () => error(503, 'Chat unavailable')

function sessionToken(request) {
  const value = request.headers.get('cookie')
  if (!value || value.length > 8192) return undefined
  const matching = value.split(';').map(part => part.trim()).filter(part => part.split('=', 1)[0].trim() === '__Host-dsbot-employee')
  if (matching.length !== 1) return undefined
  return /^__Host-dsbot-employee=([A-Za-z0-9_-]{43})$/.exec(matching[0])?.[1]
}

async function readText(request, maxBodyBytes) {
  const length = request.headers.get('content-length')
  if (length !== null && !/^\d+$/.test(length)) return { error: invalid() }
  const tooLarge = () => error(413, 'Request body too large')
  if (Number(length) > maxBodyBytes) return { error: tooLarge() }
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
      || ![null, 'identity'].includes(request.headers.get('content-encoding'))) return { error: error(415, 'Expected a JSON body') }
  if (!request.body) return { error: invalid() }
  const reader = request.body.getReader()
  const buffer = new Uint8Array(maxBodyBytes)
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (size + value.byteLength > maxBodyBytes) {
        void reader.cancel().catch(() => {})
        return { error: tooLarge() }
      }
      buffer.set(value, size)
      size += value.byteLength
    }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)))
    if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'text') || typeof body.text !== 'string' || !body.text.trim()) {
      return { error: invalid() }
    }
    return { text: body.text }
  } catch {
    return { error: invalid() }
  } finally {
    reader.releaseLock()
  }
}

function projectHistory(history, roomId) {
  if (history?.roomId !== roomId || !Array.isArray(history.messages)) return undefined
  const messages = []
  for (const row of history.messages.slice(-100)) {
    if (row?.roomId !== roomId) return undefined
    const { kind, text, by, name } = row
    if ((kind !== 'user' && kind !== 'bot') || typeof text !== 'string') continue
    messages.push({ kind, text, by: typeof by === 'string' ? by : undefined, name: typeof name === 'string' ? name : undefined })
  }
  return { roomId, messages }
}

// readHistory reads authoritative room rows with room IDs. enqueue(message, dispatch)
// returns true when queued, without waiting for execution. The queue calls dispatch(execute), which checks
// the same frozen message before invoking its trusted executor. A false result drops it.
export function createEmployeeGroupChatHandler({ origin, accounts, readRoster, readHistory, enqueue, maxBodyBytes = 16384 }) {
  const publicUrl = new URL(origin)
  if (publicUrl.protocol !== 'https:' || publicUrl.origin !== origin) throw new TypeError('Expected a canonical HTTPS origin')
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new TypeError('Expected a positive body limit')
  const access = createEmployeeGroupAccess({ readRoster, isSessionActive: identity => accounts.isSessionActive(identity) })

  return async request => {
    const url = new URL(request.url)
    const target = route.exec(url.pathname)
    const list = url.pathname === '/api/enterprise/group-chat/rooms'
    if (!target && !list) return error(404, 'Not found')
    const [, roomId, operation] = target ?? []
    const method = list || operation === 'history' ? 'GET' : 'POST'
    if (request.method !== method) return error(405, 'Method not allowed', { Allow: method })
    const site = request.headers.get('sec-fetch-site')
    if (url.origin !== origin || (method === 'POST' && (request.headers.get('origin') !== origin
        || (site !== null && site !== 'same-origin')))) return refused()
    if (url.search || url.hash) return invalid()

    try {
      const token = sessionToken(request)
      const session = token === undefined ? undefined : await accounts.resolveSession(token)
      if (!session) return error(401, 'Invalid credentials')
      const identity = Object.freeze({ personId: session.personId, loginSessionId: session.loginSessionId })
      if (list) {
        if (!await accounts.isSessionActive(identity)) return error(401, 'Invalid credentials')
        if (request.signal.aborted) return refused()
        const roster = readRoster()
        const rooms = Object.keys(roster.rooms ?? {}).sort()
          .filter(id => /^[A-Za-z0-9_-]{1,128}$/.test(id) && canAccessEmployeeRoom(roster, identity.personId, id))
          .map(id => ({ id }))
        return Response.json({ rooms }, { headers })
      }
      if (request.signal.aborted || !await access.canReadRoom(identity, roomId)) return refused()
      if (operation === 'history') {
        const history = projectHistory(await readHistory({ roomId, identity, signal: request.signal, limit: 100 }), roomId)
        if (!await access.canReadRoom(identity, roomId) || request.signal.aborted) return refused()
        if (!history) return unavailable()
        return Response.json(history, { headers })
      }
      const parsed = await readText(request, maxBodyBytes)
      if (parsed.error) return parsed.error
      const message = await access.admitMessage(identity, { roomId, requestId: randomUUID(), text: parsed.text })
      if (!message || request.signal.aborted) return refused()
      let used = false
      const decision = Promise.withResolvers()
      const dispatch = async execute => {
        if (used || typeof execute !== 'function') return false
        used = true
        if (!await decision.promise || !await access.canExecuteMessage(message, roomId)) return false
        await execute(message, () => access.canExecuteMessage(message, roomId))
        return true
      }
      try {
        if (await enqueue(message, dispatch) !== true) {
          decision.resolve(false)
          return unavailable()
        }
      } catch (cause) {
        decision.resolve(false)
        if (cause?.code === 'not-authorized') return refused()
        if (cause?.code === 'room-round-in-progress') return error(409, cause.code)
        throw cause
      }
      decision.resolve(true)
      return Response.json({ requestId: message.requestId }, { status: 202, headers })
    } catch {
      return unavailable()
    }
  }
}

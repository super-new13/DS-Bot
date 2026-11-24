import { randomUUID } from 'node:crypto'
import { createEmployeeAuthHandler } from './auth-http.js'
import { canAccessEmployeeBot } from './authorization.js'
import { createDispatchQueue } from './dispatch-queue.js'

const prefix = '/api/enterprise/private-chat/'
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
const error = (status, message, extra) => Response.json({ error: message }, { status, headers: { ...headers, ...extra } })
const refused = () => error(403, 'Chat request refused')
const invalid = () => error(400, 'Invalid chat request')
const denied = () => Object.assign(new Error('Chat request refused'), { code: 'not-authorized' })
const validId = id => typeof id === 'string' && id.length <= 128 && id.trim() !== ''
const terminalStatuses = new Set(['aborted', 'completed', 'failed'])

function sessionToken(request) {
  const value = request.headers.get('cookie')
  if (!value || value.length > 8192) return undefined
  const parts = value.split(';').map(part => part.trim()).filter(part => part.split('=', 1)[0].trim() === '__Host-dsbot-employee')
  if (parts.length !== 1) return undefined
  return /^__Host-dsbot-employee=([A-Za-z0-9_-]{43})$/.exec(parts[0])?.[1]
}

async function readBody(request, maxBytes) {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
      || ![null, 'identity'].includes(request.headers.get('content-encoding'))) return { error: error(415, 'Expected a JSON body') }
  const length = request.headers.get('content-length')
  if (length !== null && !/^\d+$/.test(length)) return { error: invalid() }
  const tooLarge = () => error(413, 'Request body too large')
  if (Number(length) > maxBytes) return { error: tooLarge() }
  if (!request.body) return { error: invalid() }
  const reader = request.body.getReader()
  const buffer = new Uint8Array(maxBytes)
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (size + value.byteLength > maxBytes) {
        void reader.cancel().catch(() => {})
        return { error: tooLarge() }
      }
      buffer.set(value, size)
      size += value.byteLength
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: invalid() }
    return { value }
  } catch {
    return { error: invalid() }
  } finally {
    reader.releaseLock()
  }
}

function streamReply(isAuthorized) {
  const encoder = new TextEncoder()
  const pending = []
  let bufferedBytes = 0
  let wake
  let closed = false
  let finished = false
  let controller
  function close() {
    if (closed) return
    closed = true
    pending.length = 0
    bufferedBytes = 0
    wake?.()
    controller.close()
  }
  const body = new ReadableStream({
    start(value) { controller = value },
    async pull() {
      while (!closed && pending.length === 0 && !finished) await new Promise(resolve => { wake = resolve })
      if (closed) return
      try {
        if (!await isAuthorized()) return close()
      } catch {
        return close()
      }
      if (closed) return
      if (pending.length === 0) return close()
      const frame = pending.shift()
      bufferedBytes -= frame.byteLength
      controller.enqueue(frame)
    },
    cancel() {
      closed = true
      pending.length = 0
      bufferedBytes = 0
      wake?.()
    },
  }, { highWaterMark: 0 })
  return {
    response: new Response(body, { headers: { ...headers, 'Content-Type': 'text/event-stream; charset=utf-8' } }),
    get closed() { return closed },
    push(frame) {
      if (closed) return
      const bytes = encoder.encode('data: ' + JSON.stringify(frame) + '\n\n')
      if (bufferedBytes + bytes.byteLength > 256 * 1024) return close()
      bufferedBytes += bytes.byteLength
      pending.push(bytes)
      wake?.()
    },
    finish() { finished = true; wake?.() },
  }
}

// The host supplies fresh authoritative roster state and resolves each Bot to its
// configured worker. Both lookups are synchronous and use server-owned state.
export function createEmployeePrivateChatHandler({ accounts, origin, readRoster, resolveBot, limits, maxBodyBytes = 16384 }) {
  if (typeof readRoster !== 'function' || typeof resolveBot !== 'function' || !Number.isSafeInteger(maxBodyBytes)
      || maxBodyBytes < 1 || maxBodyBytes > 65536) throw new TypeError('Invalid private chat configuration')
  const auth = createEmployeeAuthHandler({ accounts, origin })
  const sessions = new Map()
  const requests = new Map()

  function route(personId, botId) {
    if (!canAccessEmployeeBot(readRoster(), personId, botId)) return undefined
    const target = resolveBot(botId)
    if (target?.botId !== botId || !validId(target.nodeId) || !target.worker) return undefined
    return { nodeId: target.nodeId, worker: target.worker }
  }

  function routeStillMatches(entry) {
    const target = route(entry.personId, entry.botId)
    return target?.nodeId === entry.nodeId && target?.worker === entry.worker
  }

  async function authorized(entry) {
    return await accounts.isSessionActive(entry.identity) && routeStillMatches(entry)
  }

  const queue = createDispatchQueue({ ...limits,
    authorize: async entry => !entry.stream.closed && await authorized(entry),
    async execute({ requestId, text }) {
      const entry = requests.get(requestId)
      if (!entry) throw denied()
      const { worker, sessionKey, personId, botId, nodeId, stream } = entry
      let session = sessions.get(sessionKey)
      if (!session) {
        const scope = await worker.create({ sessionKey, personId, botId })
        if (scope.sessionKey !== sessionKey || scope.personId !== personId || scope.botId !== botId || !validId(scope.sessionId)) throw denied()
        session = { scope, worker, nodeId }
        sessions.set(sessionKey, session)
      }
      if (session.worker !== worker || session.nodeId !== nodeId || stream.closed || !await authorized(entry)) throw denied()
      if (stream.closed) throw denied()
      entry.activeScope = session.scope
      try {
        const result = await worker.submit({ ...session.scope, requestId, text }, event => {
          if (event.sessionId !== session.scope.sessionId || event.requestId !== requestId) return
          if ((event.type === 'delta' || event.type === 'reply') && typeof event.text === 'string') {
            stream.push({ type: event.type, requestId, text: event.text })
          }
        })
        if (result?.requestId !== requestId || result.sessionId !== session.scope.sessionId || !terminalStatuses.has(result.status)) throw denied()
        stream.push({ type: 'done', requestId, status: result.status })
      } finally {
        entry.activeScope = undefined
      }
    },
  })

  return async (request, context) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/enterprise/auth/')) return auth(request, context)
    const submit = url.pathname === prefix + 'send'
    if (!submit && url.pathname !== prefix + 'cancel') return error(404, 'Not found')
    if (request.method !== 'POST') return error(405, 'Method not allowed', { Allow: 'POST' })
    const site = request.headers.get('sec-fetch-site')
    if (url.origin !== origin || request.headers.get('origin') !== origin || (site !== null && site !== 'same-origin')) return refused()
    if (url.search || url.hash) return invalid()
    try {
      const token = sessionToken(request)
      const identity = token === undefined ? undefined : await accounts.resolveSession(token)
      if (!identity) return error(401, 'Invalid credentials')
      const parsed = await readBody(request, maxBodyBytes)
      if (parsed.error) return parsed.error
      const body = parsed.value
      const fields = submit ? ['botId', 'text'] : ['botId', 'requestId']
      if (Object.keys(body).length !== 2 || !fields.every(field => Object.hasOwn(body, field)) || !validId(body.botId)
          || (submit ? typeof body.text !== 'string' || !body.text.trim() : !validId(body.requestId))) return invalid()
      const { personId } = identity
      const { botId } = body
      if (!await accounts.isSessionActive(identity)) return error(401, 'Invalid credentials')
      const target = route(personId, botId)
      if (!target) return refused()
      if (!submit) {
        const entry = requests.get(body.requestId)
        if (!entry?.activeScope || entry.personId !== personId || entry.botId !== botId) return refused()
        const [callerActive, originActive] = await Promise.all([accounts.isSessionActive(identity), accounts.isSessionActive(entry.identity)])
        if (!callerActive || !originActive || !entry.activeScope || !routeStillMatches(entry)) return refused()
        try {
          const result = entry.worker.cancel({ ...entry.activeScope, requestId: entry.requestId })
          return result?.accepted === true ? Response.json({ accepted: true }, { status: 202, headers }) : refused()
        } catch (cause) {
          if (cause?.code === 'not-authorized') return refused()
          throw cause
        }
      }
      if (request.signal.aborted) return refused()
      const requestId = randomUUID()
      const entry = { identity, personId, botId, ...target, requestId, sessionKey: JSON.stringify([personId, botId]) }
      const stream = streamReply(() => authorized(entry))
      entry.stream = stream
      const detach = () => stream.close()
      request.signal.addEventListener('abort', detach, { once: true })
      requests.set(requestId, entry)
      stream.push({ type: 'queued', requestId })
      void queue.enqueue({ ...entry, text: body.text })
        .catch(cause => stream.push({ type: 'error', requestId, code: ['not-authorized', 'queue-full'].includes(cause?.code) ? cause.code : 'unavailable' }))
        .finally(() => {
          requests.delete(requestId)
          request.signal.removeEventListener('abort', detach)
          stream.finish()
        })
      return stream.response
    } catch {
      return error(503, 'Chat unavailable')
    }
  }
}

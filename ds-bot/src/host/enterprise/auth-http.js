const paths = new Map([
  ['/api/enterprise/auth/redeem', 'POST'],
  ['/api/enterprise/auth/login', 'POST'],
  ['/api/enterprise/auth/logout', 'POST'],
  ['/api/enterprise/auth/session', 'GET'],
])

const cookieName = '__Host-dsbot-employee'
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const validToken = value => typeof value === 'string' && tokenPattern.test(value)

function respond(status, body, headers) {
  const fields = new Headers(headers)
  fields.set('Cache-Control', 'no-store')
  fields.set('X-Content-Type-Options', 'nosniff')
  fields.set('Referrer-Policy', 'no-referrer')
  if (body === undefined) return new Response(null, { status, headers: fields })
  return Response.json(body, { status, headers: fields })
}

const error = (status, message, headers) => respond(status, { error: message }, headers)
const denied = () => error(401, 'Invalid credentials')
const badRequest = () => error(400, 'Invalid request')
const limited = retryAfter => error(429, 'Too many requests', { 'Retry-After': String(retryAfter) })

function cookie(token, maxAge) {
  return cookieName + '=' + token + '; Path=/; Max-Age=' + maxAge + '; Secure; HttpOnly; SameSite=Strict'
}

function sessionToken(request) {
  const header = request.headers.get('cookie')
  if (!header || header.length > 8192) return undefined
  let value
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name.trim() !== cookieName) continue
    if (value !== undefined) return undefined
    value = rest.join('=')
  }
  return validToken(value) ? value : undefined
}

function contentLength(request) {
  const value = request.headers.get('content-length')
  return value === null || /^\d+$/.test(value) ? Number(value) : NaN
}

async function readCredentials(request, limit) {
  const length = contentLength(request)
  if (Number.isNaN(length)) return { response: badRequest() }
  if (length > limit) return { response: error(413, 'Request body too large') }
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json' ||
      ![null, 'identity'].includes(request.headers.get('content-encoding'))) {
    return { response: error(415, 'Expected a JSON body') }
  }
  if (!request.body) return { response: badRequest() }
  const reader = request.body.getReader()
  const bytes = new Uint8Array(limit)
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (size + value.byteLength > limit) {
        void reader.cancel().catch(() => {})
        return { response: error(413, 'Request body too large') }
      }
      bytes.set(value, size)
      size += value.byteLength
    }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)))
    if (!body || Array.isArray(body) || typeof body !== 'object') return { response: badRequest() }
    return { body }
  } catch {
    return { response: badRequest() }
  } finally {
    reader.releaseLock()
  }
}

function rateLimit({ windowMs, globalLimit, clientLimit, maxClients, now }) {
  const clients = new Map()
  let expiresAt = 0
  let total = 0
  return key => {
    const time = now()
    if (time >= expiresAt) {
      expiresAt = time + windowMs
      total = 0
      clients.clear()
    }
    const count = clients.get(key) ?? 0
    if (total >= globalLimit || count >= clientLimit || (!clients.has(key) && clients.size >= maxClients)) {
      return Math.max(1, Math.ceil((expiresAt - time) / 1000))
    }
    clients.set(key, count + 1)
    total++
    return 0
  }
}

// The adapter supplies a canonical public HTTPS URL and an optional trusted client key
// (for example, the ingress-verified peer address). Never source the key from raw headers.
export function createEmployeeAuthHandler({ accounts, origin, now = Date.now, maxBodyBytes = 8192, windowMs = 60_000,
  globalLimit = 60, clientLimit = 8, maxClients = 256, maxConcurrent = 2 }) {
  const publicUrl = new URL(origin)
  if (publicUrl.protocol !== 'https:' || publicUrl.origin !== origin) throw new TypeError('Expected a canonical HTTPS origin')
  for (const value of [maxBodyBytes, windowMs, globalLimit, clientLimit, maxClients, maxConcurrent]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Expected positive integer auth limits')
  }
  const take = rateLimit({ windowMs, globalLimit, clientLimit, maxClients, now })
  let active = 0

  async function checkCredentials(request, isLogin, clientKey) {
    const peer = typeof clientKey === 'string' && clientKey.length > 0 && clientKey.length <= 128 ? clientKey : undefined
    const retryAfter = take(peer)
    if (retryAfter !== 0) return limited(retryAfter)
    const { body, response } = await readCredentials(request, maxBodyBytes)
    if (response) return response
    const field = isLogin ? 'personId' : 'token'
    if (Object.keys(body).length !== 2 || !Object.hasOwn(body, field) || !Object.hasOwn(body, 'password')) return badRequest()
    const credential = body[field]
    const { password } = body
    if (typeof credential !== 'string' || typeof password !== 'string') return badRequest()
    if (active >= maxConcurrent) return limited(1)
    active++
    try {
      if (!isLogin) return await accounts.redeemInvite(credential, password) ? respond(204) : denied()
      const session = await accounts.login(credential, password)
      if (!session) return denied()
      const maxAge = Math.floor((session.expiresAt - now()) / 1000)
      if (!validToken(session.token) || !Number.isSafeInteger(maxAge) || maxAge <= 0) return error(503, 'Authentication unavailable')
      return respond(204, undefined, { 'Set-Cookie': cookie(session.token, maxAge) })
    } finally {
      active--
    }
  }

  return async (request, { clientKey } = {}) => {
    const url = new URL(request.url)
    const method = paths.get(url.pathname)
    if (!method) return error(404, 'Not found')
    if (request.method !== method) return error(405, 'Method not allowed', { Allow: method })
    if (url.origin !== origin) return error(403, 'Request origin denied')
    if (method === 'POST') {
      const site = request.headers.get('sec-fetch-site')
      if (request.headers.get('origin') !== origin || (site !== null && site !== 'same-origin')) {
        return error(403, 'Request origin denied')
      }
    }
    if (url.search || url.hash) return badRequest()
    try {
      if (url.pathname.endsWith('/login')) return await checkCredentials(request, true, clientKey)
      if (url.pathname.endsWith('/redeem')) return await checkCredentials(request, false, clientKey)
      const logout = method === 'POST'
      if (logout && (request.body || contentLength(request) !== 0)) return badRequest()
      const token = sessionToken(request)
      const session = token === undefined ? undefined : await accounts.resolveSession(token)
      if (!logout) return session ? respond(200, { personId: session.personId }) : denied()
      if (session) await accounts.revokeSession(session.personId, session.loginSessionId)
      return respond(204, undefined, { 'Set-Cookie': cookie('', 0) })
    } catch {
      return error(503, 'Authentication unavailable')
    }
  }
}

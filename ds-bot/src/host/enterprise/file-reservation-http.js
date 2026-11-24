const routes = new Map([
  ['/internal/enterprise/file-reservations/reserve', 'reserve'],
  ['/internal/enterprise/file-reservations/settle', 'settle'],
])
const ids = ['nodeId', 'personId', 'botId', 'sessionId', 'requestId', 'dispatchId', 'targetId', 'ruleId', 'ruleVersion']
const scopeFields = [...ids, 'roomId', 'operation', 'version', 'contentDigest']
const terminal = new Set(['completed', 'cancelled', 'fenced'])
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const error = (status, code, extra) => Response.json({ error: code }, { status, headers: { ...headers, ...extra } })
const refused = () => error(403, 'reservation-refused')
const invalid = () => error(400, 'invalid-request')
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

function validScope(scope) {
  if (!exact(scope, scopeFields) || !ids.every(key => id(scope[key]))) return false
  const { roomId, operation, version, contentDigest } = scope
  return (roomId === null || id(roomId)) && ['read', 'create', 'modify'].includes(operation)
    && (operation === 'create' ? version === null : typeof version === 'string' && version.length <= 512 && version.trim() !== '')
    && (operation === 'read' ? contentDigest === null : typeof contentDigest === 'string' && /^[a-f0-9]{64}$/.test(contentDigest))
}

async function readBody(request, limit) {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
      || ![null, 'identity'].includes(request.headers.get('content-encoding'))) return error(415, 'expected-json')
  const length = request.headers.get('content-length')
  if (!request.body || (length !== null && !/^\d+$/.test(length))) return invalid()
  if (Number(length) > limit) return error(413, 'body-too-large')
  const reader = request.body.getReader()
  const bytes = new Uint8Array(limit)
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (size + value.byteLength > limit) {
        void reader.cancel().catch(() => {})
        return error(413, 'body-too-large')
      }
      bytes.set(value, size)
      size += value.byteLength
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)))
  } catch { return invalid() }
  finally { reader.releaseLock() }
}

// authenticateWorker maps transport metadata to a node ID. The scope check
// protects receipt visibility as well as mutations. The reservation service
// must separately check live policy inside the admission transaction.
// verifySettlement must resolve the evidence ID from trusted records and check
// the exact node, scope and terminal outcome. A peer assertion is insufficient.
export function createFileReservationHttpHandler({ origin, reservations, authenticateWorker, authorizeScope,
  verifySettlement, maxBodyBytes = 8192 }) {
  if (typeof origin !== 'string' || !origin.startsWith('https://') || URL.parse(origin)?.origin !== origin
      || ![reservations?.reserve, reservations?.settle, authenticateWorker, authorizeScope, verifySettlement].every(fn => typeof fn === 'function')
      || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 65536) throw new TypeError('Invalid reservation HTTP configuration')

  return async (request, transport) => {
    const url = new URL(request.url)
    const action = routes.get(url.pathname)
    if (!action) return error(404, 'not-found')
    if (request.method !== 'POST') return error(405, 'method-not-allowed', { Allow: 'POST' })
    if (url.origin !== origin || url.search || url.hash || request.signal.aborted) return refused()
    try {
      const nodeId = await authenticateWorker(transport)
      if (!id(nodeId) || request.signal.aborted) return refused()
      const body = await readBody(request, maxBodyBytes)
      if (body instanceof Response) return body
      const settling = action === 'settle'
      if (!exact(body, settling ? ['scope', 'status', 'evidenceId'] : ['scope']) || !validScope(body.scope)
          || (settling && (!terminal.has(body.status) || !id(body.evidenceId)))) return invalid()
      if (body.scope.nodeId !== nodeId) return refused()
      const scope = Object.freeze({ ...body.scope, nodeId })
      const allowed = () => !request.signal.aborted && authorizeScope(nodeId, action, scope) === true
      if (!allowed()) return refused()
      if (!settling) return Response.json(await reservations.reserve(scope), { headers })
      const evidence = Object.freeze({ scope, status: body.status, evidenceId: body.evidenceId })
      if (await verifySettlement(nodeId, evidence, { signal: request.signal }) !== true || !allowed()) return refused()
      const revocation = await reservations.settle(scope, body.status)
      return Response.json({ revocation }, { headers })
    } catch (cause) {
      if (cause?.code === 'not-authorized' || request.signal.aborted) return refused()
      return error(503, 'reservation-unavailable')
    }
  }
}

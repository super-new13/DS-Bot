import { createFileReservationHttpHandler } from './file-reservation-http.js'
import { createInternalTlsTransport, startInternalTls } from './worker-tls.js'

const root = '/internal/enterprise/file-reservations/'
const routes = [root + 'reserve', root + 'settle']
const statuses = new Set(['reserved', 'completed', 'cancelled', 'fenced'])
const revocations = new Set(['active', 'pending', 'revoked'])
const unknown = () => Object.assign(new Error('File reservation outcome unknown'), { code: 'reservation-outcome-unknown' })
const denied = () => Object.assign(new Error('File reservation refused'), { code: 'reservation-refused' })

export async function startFileReservationTls({ tls, reservations, resolveWorker, authorizeScope, verifySettlement,
  host, port, origin, timeoutMs = 5000, maxBodyBytes = 8192, maxConnections } = {}) {
  if (![resolveWorker, authorizeScope, verifySettlement, reservations?.reserve, reservations?.settle]
    .every(fn => typeof fn === 'function') || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 65536) {
    throw new TypeError('Invalid reservation listener configuration')
  }
  let handle
  const entry = await startInternalTls({ ...tls, host, port, origin, timeoutMs, maxBodyBytes, maxConnections,
    handler: (request, peer) => handle ? handle(request, peer) : new Response(null, { status: 503 }),
  }, routes)
  try {
    handle = createFileReservationHttpHandler({ origin: entry.origin, reservations, authorizeScope, verifySettlement, maxBodyBytes,
      authenticateWorker: peer => resolveWorker(peer.fingerprint),
    })
    return entry
  } catch (error) {
    await entry.close()
    throw error
  }
}

async function readResponse(response) {
  if (!response.body || response.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') throw unknown()
  const reader = response.body.getReader()
  const bytes = new Uint8Array(2048)
  let size = 0
  let complete = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (size + value.byteLength > bytes.length) throw unknown()
      bytes.set(value, size)
      size += value.byteLength
    }
    complete = true
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)))
  } finally {
    if (!complete) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function createFileReservationTlsClient({ origin, ca, cert, key, timeoutMs = 5000, maxBodyBytes = 8192 }) {
  const transport = createInternalTlsTransport({ origin, ca, cert, key, timeoutMs, maxBodyBytes }, routes)
  async function send(action, payload, signal) {
    try {
      const response = await transport(new Request(origin + root + action, {
        method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }))
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {})
        if ([400, 403, 413, 415].includes(response.status)) throw denied()
        throw unknown()
      }
      const result = await readResponse(response)
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw unknown()
      if (action === 'reserve') {
        if (Object.keys(result).length !== 2 || typeof result.issued !== 'boolean' || !statuses.has(result.status)
            || (result.issued && result.status !== 'reserved')) throw unknown()
      } else if (Object.keys(result).length !== 1 || !revocations.has(result.revocation)) throw unknown()
      return Object.freeze(result)
    } catch (error) {
      if (error?.code === 'reservation-refused') throw error
      throw unknown()
    }
  }
  return {
    reserve: (scope, { signal } = {}) => send('reserve', { scope }, signal),
    settle: (scope, status, evidenceId, { signal } = {}) => send('settle', { scope, status, evidenceId }, signal),
  }
}

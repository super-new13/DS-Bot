import { createInternalTlsTransport, startInternalTls } from './worker-tls.js'

const route = '/internal/enterprise/file-evidence/ingest'
const ids = ['nodeId', 'personId', 'botId', 'sessionId', 'requestId', 'dispatchId', 'targetId', 'ruleId', 'ruleVersion']
const fields = [...ids, 'roomId', 'operation', 'version', 'contentDigest']
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const ack = value => exact(value, ['inserted']) && typeof value.inserted === 'boolean'
const error = (status, code) => Response.json({ error: code }, { status })
const unknown = () => Object.assign(new Error('Evidence ingestion acknowledgment unknown'), { code: 'evidence-outcome-unknown' })
const refused = () => Object.assign(new Error('Evidence ingestion refused'), { code: 'evidence-refused' })

function valid(entry) {
  if (!exact(entry, ['evidenceId', 'scope', 'status']) || !id(entry.evidenceId) || entry.status !== 'completed'
      || !exact(entry.scope, fields) || !ids.every(key => id(entry.scope[key]))) return false
  const { roomId, operation, version, contentDigest } = entry.scope
  return (roomId === null || id(roomId)) && ['read', 'modify', 'create'].includes(operation)
    && (operation === 'create' ? version === null : typeof version === 'string' && version.length <= 512 && version.trim() !== '')
    && (operation === 'read' ? contentDigest === null : typeof contentDigest === 'string' && /^[a-f0-9]{64}$/.test(contentDigest))
}

async function readJson(message, limit) {
  if (!message.body || message.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new TypeError('Expected evidence JSON')
  }
  const reader = message.body.getReader()
  const buffer = new Uint8Array(limit)
  let length = 0
  let complete = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (length + value.byteLength > limit) throw new RangeError('Evidence body too large')
      buffer.set(value, length)
      length += value.byteLength
    }
    complete = true
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)))
  } finally {
    if (!complete) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// Enroll dedicated producer leaf certificates. The supplied callback must
// acknowledge only durable insertion or an exact duplicate in the center store.
export async function startFileEvidenceTls({ tls, producerGrants, ingest, host, port, origin,
  timeoutMs = 5000, maxBodyBytes = 8192, maxConnections } = {}) {
  if (!Array.isArray(producerGrants) || producerGrants.length === 0 || typeof ingest !== 'function'
      || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 65536) {
    throw new TypeError('Invalid evidence listener configuration')
  }
  const grants = new Map()
  for (const grant of producerGrants) {
    if (!exact(grant, ['fingerprint', 'nodeId']) || !id(grant.nodeId) || typeof grant.fingerprint !== 'string'
        || !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(grant.fingerprint) || grants.has(grant.fingerprint)) {
      throw new TypeError('Invalid evidence producer grant')
    }
    grants.set(grant.fingerprint, grant.nodeId)
  }
  return startInternalTls({ ...tls, host, port, origin, timeoutMs, maxBodyBytes, maxConnections,
    async handler(request, peer) {
      const nodeId = grants.get(peer.fingerprint)
      if (!nodeId) return error(403, 'evidence-refused')
      if (![null, 'identity'].includes(request.headers.get('content-encoding'))) return error(415, 'expected-json')
      let entry
      try { entry = await readJson(request, maxBodyBytes) } catch { return error(400, 'invalid-evidence') }
      if (!valid(entry)) return error(400, 'invalid-evidence')
      if (nodeId !== entry.scope.nodeId || request.signal.aborted) return error(403, 'evidence-refused')
      Object.freeze(entry.scope)
      const result = await ingest(Object.freeze(entry), { signal: request.signal })
      return ack(result) ? Response.json({ inserted: result.inserted }) : error(503, 'evidence-unavailable')
    },
  }, [route])
}

export function createFileEvidenceTlsClient({ origin, ca, cert, key, timeoutMs = 5000, maxBodyBytes = 8192 }) {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 65536) throw new TypeError('Invalid evidence client configuration')
  const transport = createInternalTlsTransport({ origin, ca, cert, key, timeoutMs, maxBodyBytes }, [route])
  return async function ingest(entry, { signal } = {}) {
    if (!valid(entry)) throw refused()
    try {
      const response = await transport(new Request(origin + route, { method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry),
      }))
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {})
        if ([400, 403, 413, 415].includes(response.status)) throw refused()
        throw unknown()
      }
      const result = await readJson(response, 128)
      if (!ack(result) || signal?.aborted) throw unknown()
      return result
    } catch (cause) {
      if (cause?.code === 'evidence-refused') throw cause
      throw unknown()
    }
  }
}

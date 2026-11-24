import { createHash } from 'node:crypto'

const root = '/internal/enterprise/worker/'
const actions = new Map([
  ['create', ['nodeId', 'botId', 'personId']],
  ['submit', ['nodeId', 'botId', 'personId', 'sessionId', 'requestId', 'text']],
  ['cancel', ['nodeId', 'botId', 'personId', 'sessionId', 'requestId']],
  ['status', ['nodeId', 'botId', 'personId', 'sessionId', 'requestId']],
])
const terminal = new Set(['completed', 'aborted', 'failed'])
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const json = (status, value, extra) => Response.json(value, { status, headers: { ...headers, ...extra } })
const error = (status, code, extra) => json(status, { error: code }, extra)
const refused = () => error(403, 'worker-refused')
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const matches = (a, b) => ['nodeId', 'botId', 'personId', 'sessionId'].every(key => a[key] === b[key])

async function readBody(request, limit) {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json'
      || ![null, 'identity'].includes(request.headers.get('content-encoding'))) return error(415, 'expected-json')
  const length = request.headers.get('content-length')
  if (!request.body || (length !== null && !/^\d+$/.test(length))) return error(400, 'invalid-request')
  if (Number(length) > limit) return error(413, 'body-too-large')
  const reader = request.body.getReader()
  const buffer = new Uint8Array(limit)
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (size + value.byteLength > limit) {
        void reader.cancel().catch(() => {})
        return error(413, 'body-too-large')
      }
      buffer.set(value, size)
      size += value.byteLength
    }
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)))
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : error(400, 'invalid-request')
  } catch {
    return error(400, 'invalid-request')
  } finally {
    reader.releaseLock()
  }
}

function liveReply(authorized) {
  const encoder = new TextEncoder()
  const pending = []
  let bytes = 0
  let controller
  let wake
  let closed = false
  let finished = false
  function close() {
    if (closed) return
    closed = true
    pending.length = 0
    wake?.()
    controller.close()
  }
  const body = new ReadableStream({
    start(value) { controller = value },
    async pull() {
      while (!closed && !finished && pending.length === 0) await new Promise(resolve => { wake = resolve })
      if (closed) return
      if (!authorized() || pending.length === 0) return close()
      const chunk = pending.shift()
      bytes -= chunk.byteLength
      controller.enqueue(chunk)
    },
    cancel() {
      closed = true
      pending.length = 0
      wake?.()
    },
  }, { highWaterMark: 0 })
  return {
    response: new Response(body, { status: 202, headers: { ...headers, 'Content-Type': 'application/x-ndjson' } }),
    push(value) {
      if (closed) return
      const chunk = encoder.encode(JSON.stringify(value) + '\n')
      if (bytes + chunk.byteLength > 256 * 1024) return close()
      bytes += chunk.byteLength
      pending.push(chunk)
      wake?.()
    },
    finish() { finished = true; wake?.() },
  }
}

// The listener passes authenticated transport metadata out of band. Neither
// callback gets the Request. authorizePeer must synchronously check current
// node, actor, Bot, Session and action grants against authoritative state.
// The worker context must already enforce its execution and tool boundary.
export function createWorkerHttpHandler({ nodeId, origin, authenticatePeer, authorizePeer, worker, receipts,
  maxBodyBytes = 16384, maxActive = 4 }) {
  if (!validId(nodeId) || new URL(origin).origin !== origin || !origin.startsWith('https://')
      || typeof authenticatePeer !== 'function' || typeof authorizePeer !== 'function'
      || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 65536
      || !Number.isSafeInteger(maxActive) || maxActive < 1) throw new TypeError('Invalid worker HTTP configuration')
  const active = new Map()
  const sessions = new Set()

  function publicReceipt(scope, receipt) {
    const run = active.get(receipt.requestId)
    return receipt.status === 'admitted' && (!run || !matches(run.scope, scope)) ? { ...receipt, status: 'unknown' } : receipt
  }

  async function submit(scope, adapterScope, requestId, text, permitted) {
    const digest = createHash('sha256').update(text, 'utf16le').digest('hex')
    const existing = await receipts.lookup(scope, requestId)
    if (!permitted()) return refused()
    if (!existing && (active.size >= maxActive || active.has(requestId) || sessions.has(scope.sessionId))) return error(409, 'worker-busy')
    if (existing) {
      // Compare the digest inside the receipt transaction even for duplicates.
      const duplicate = await receipts.admit(scope, requestId, digest)
      if (!permitted()) return refused()
      return json(200, { receipt: publicReceipt(scope, duplicate.receipt) })
    }
    const run = { scope, started: false }
    active.set(requestId, run)
    sessions.add(scope.sessionId)
    function clear() {
      active.delete(requestId)
      sessions.delete(scope.sessionId)
    }
    try {
      const admission = await receipts.admit(scope, requestId, digest)
      if (!admission.admitted) {
        clear()
        return permitted() ? json(200, { receipt: publicReceipt(scope, admission.receipt) }) : refused()
      }
      if (!permitted()) {
        await receipts.finish(scope, requestId, 'aborted')
        clear()
        return refused()
      }
      const stream = liveReply(permitted)
      stream.push({ type: 'receipt', receipt: admission.receipt })
      run.started = true
      void (async () => {
        try {
          const result = await worker.submit({ ...adapterScope, requestId, text }, event => {
            if (event.sessionId !== scope.sessionId || event.requestId !== requestId || !permitted()) return
            if ((event.type === 'delta' || event.type === 'reply') && typeof event.text === 'string') {
              stream.push({ type: event.type, requestId, text: event.text })
            }
          })
          if (result?.requestId !== requestId || result.sessionId !== scope.sessionId || !terminal.has(result.status)) {
            throw new Error('Unverified worker outcome')
          }
          const receipt = await receipts.finish(scope, requestId, result.status)
          stream.push({ type: 'receipt', receipt })
        } catch {
          stream.push({ type: 'receipt', receipt: { ...admission.receipt, status: 'unknown' } })
        } finally {
          clear()
          stream.finish()
        }
      })()
      return stream.response
    } catch (cause) {
      clear()
      throw cause
    }
  }

  return async (request, transport) => {
    const url = new URL(request.url)
    const action = url.pathname.startsWith(root) ? url.pathname.slice(root.length) : ''
    const fields = actions.get(action)
    if (!fields) return error(404, 'not-found')
    if (request.method !== 'POST') return error(405, 'method-not-allowed', { Allow: 'POST' })
    if (url.origin !== origin || url.search || url.hash) return refused()
    try {
      const peer = await authenticatePeer(transport)
      if (peer === undefined || peer === null || peer === false) return refused()
      const body = await readBody(request, maxBodyBytes)
      if (body instanceof Response) return body
      if (Object.keys(body).length !== fields.length || !fields.every(key => Object.hasOwn(body, key)
          && (key === 'text' ? typeof body.text === 'string' && body.text.trim() !== '' : validId(body[key])))) {
        return error(400, 'invalid-request')
      }
      if (body.nodeId !== nodeId) return refused()
      const { botId, personId, sessionId, requestId, text } = body
      const scope = Object.freeze({ nodeId, botId, personId, ...(sessionId === undefined ? {} : { sessionId }) })
      const target = Object.freeze({ action, scope, requestId })
      const permitted = () => {
        try { return authorizePeer(peer, target) === true } catch { return false }
      }
      if (!permitted()) return refused()
      const adapterScope = { botId, personId, sessionId, sessionKey: JSON.stringify([nodeId, botId, personId]) }
      if (action === 'create') {
        const created = await worker.create(adapterScope)
        if (!permitted()) return refused()
        if (!validId(created?.sessionId) || created.personId !== personId || created.botId !== botId
            || created.sessionKey !== adapterScope.sessionKey) return error(503, 'worker-unavailable')
        return json(201, { sessionId: created.sessionId })
      }
      if (action === 'submit') return await submit(scope, adapterScope, requestId, text, permitted)
      if (action === 'status') {
        const receipt = await receipts.lookup(scope, requestId)
        if (!permitted()) return refused()
        return receipt ? json(200, { receipt: publicReceipt(scope, receipt) }) : error(404, 'not-found')
      }
      const run = active.get(requestId)
      if (!run?.started || !matches(run.scope, scope)) return refused()
      const result = worker.cancel({ ...adapterScope, requestId })
      return result?.accepted === true ? json(202, { accepted: true }) : refused()
    } catch (cause) {
      if (cause?.code === 'not-authorized') return refused()
      if (cause?.code === 'receipt-conflict') return error(409, 'receipt-conflict')
      return error(503, 'worker-unavailable')
    }
  }
}

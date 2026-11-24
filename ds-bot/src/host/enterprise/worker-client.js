const root = '/internal/enterprise/worker/'
const terminal = new Set(['completed', 'aborted', 'failed'])
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const timestamp = value => Number.isSafeInteger(value) && value >= 0
const exact = (object, fields) => object !== null && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).length === fields.length && fields.every(field => Object.hasOwn(object, field))
const error = (code, status) => Object.assign(new Error(code), { code, ...(status === undefined ? {} : { status }) })
const invalidResponse = () => error('invalid-worker-response')
const unknown = requestId => Object.freeze({ requestId, status: 'unknown' })
const mediaType = response => response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()

function verifyReceipt(receipt, requestId) {
  const status = receipt?.status
  const done = terminal.has(status)
  const fields = ['requestId', 'status', 'admittedAt', ...(done ? ['finishedAt'] : [])]
  if (!exact(receipt, fields) || receipt.requestId !== requestId || !timestamp(receipt.admittedAt)
      || (done ? !timestamp(receipt.finishedAt) || receipt.finishedAt < receipt.admittedAt : !['admitted', 'unknown'].includes(status))) {
    throw invalidResponse()
  }
  return Object.freeze(receipt)
}

function release(reader, complete) {
  if (!complete) void reader.cancel().catch(() => {})
  reader.releaseLock()
}

async function readJson(response) {
  if (!response.body || mediaType(response) !== 'application/json') throw invalidResponse()
  const reader = response.body.getReader()
  const buffer = new Uint8Array(4096)
  let size = 0
  let complete = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (size + value.byteLength > buffer.length) throw invalidResponse()
      buffer.set(value, size)
      size += value.byteLength
    }
    complete = true
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)))
  } finally { release(reader, complete) }
}

async function* readFrames(response, maxFrameBytes, maxStreamBytes) {
  if (!response.body || mediaType(response) !== 'application/x-ndjson') throw invalidResponse()
  const reader = response.body.getReader()
  const buffer = new Uint8Array(maxFrameBytes)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let total = 0
  let complete = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxStreamBytes) throw invalidResponse()
      for (let offset = 0; offset < value.byteLength;) {
        const delimiter = value.indexOf(10, offset)
        const end = delimiter < 0 ? value.byteLength : delimiter
        const part = value.subarray(offset, end)
        if (size + part.byteLength > buffer.length) throw invalidResponse()
        buffer.set(part, size)
        size += part.byteLength
        if (delimiter < 0) break
        yield JSON.parse(decoder.decode(buffer.subarray(0, size)))
        size = 0
        offset = end + 1
      }
    }
    if (size !== 0) throw invalidResponse()
    complete = true
  } finally { release(reader, complete) }
}

function isRejected(response) {
  return [400, 403, 409, 413, 415].includes(response.status)
}

// transport(request) authenticates the configured HTTPS peer, honors the signal
// and redirect mode, and does not retry. Use a status read to reconcile timeouts.
// Scope comes from the authenticated host's routing and Session ownership data.
export function createWorkerClient({ origin, nodeId, transport, maxFrameBytes = 256 * 1024, maxStreamBytes = 4 * 1024 * 1024 }) {
  if (typeof origin !== 'string' || !origin.startsWith('https://') || new URL(origin).origin !== origin
      || !validId(nodeId) || typeof transport !== 'function'
      || !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 1024 * 1024
      || !Number.isSafeInteger(maxStreamBytes) || maxStreamBytes < maxFrameBytes) throw new TypeError('Invalid worker client configuration')

  function scoped(scope, needsSession = true) {
    const { nodeId: requestedNode, botId, personId, sessionId } = scope ?? {}
    if (requestedNode !== nodeId || !validId(botId) || !validId(personId) || (needsSession && !validId(sessionId))) {
      throw new TypeError('Invalid worker scope')
    }
    return { nodeId, botId, personId, ...(needsSession ? { sessionId } : {}) }
  }

  function operation(scope, requestId) {
    if (!validId(requestId)) throw new TypeError('Invalid worker request ID')
    return { ...scoped(scope), requestId }
  }

  async function send(action, data, signal) {
    const request = new Request(origin + root + action, {
      method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    })
    const response = await transport(request)
    if (!(response instanceof Response) || response.redirected || (response.url && response.url !== request.url)) {
      void response?.body?.cancel().catch(() => {})
      throw invalidResponse()
    }
    return response
  }

  async function acknowledge(action, data, signal, status, check) {
    try {
      const response = await send(action, data, signal)
      if (response.status !== status) {
        void response.body?.cancel().catch(() => {})
        if (isRejected(response)) throw error('worker-refused', response.status)
        throw invalidResponse()
      }
      const result = await readJson(response)
      if (!check(result)) throw invalidResponse()
      return Object.freeze(result)
    } catch (cause) {
      if (cause?.code === 'worker-refused') throw cause
      throw error('worker-outcome-unknown')
    }
  }

  function create(scope, { signal } = {}) {
    return acknowledge('create', scoped(scope, false), signal, 201, result => exact(result, ['sessionId']) && validId(result.sessionId))
  }

  function cancel(scope, requestId, { signal } = {}) {
    return acknowledge('cancel', operation(scope, requestId), signal, 202, result => exact(result, ['accepted']) && result.accepted === true)
  }

  async function status(scope, requestId, { signal } = {}) {
    const input = operation(scope, requestId)
    try {
      const response = await send('status', input, signal)
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {})
        if (isRejected(response)) throw error('worker-refused', response.status)
        return unknown(requestId)
      }
      const result = await readJson(response)
      if (!exact(result, ['receipt'])) throw invalidResponse()
      return verifyReceipt(result.receipt, requestId)
    } catch (cause) {
      if (cause?.code === 'worker-refused') throw cause
      return unknown(requestId)
    }
  }

  async function submit(scope, requestId, text, { signal, onEvent = () => {} } = {}) {
    const input = operation(scope, requestId)
    if (typeof text !== 'string' || !text.trim() || typeof onEvent !== 'function') throw new TypeError('Invalid worker submission')
    let admission
    let outcome
    try {
      const response = await send('submit', { ...input, text }, signal)
      if (response.status === 200) {
        const result = await readJson(response)
        if (!exact(result, ['receipt'])) throw invalidResponse()
        return verifyReceipt(result.receipt, requestId)
      }
      if (response.status !== 202) {
        void response.body?.cancel().catch(() => {})
        if (isRejected(response)) throw error('worker-refused', response.status)
        return unknown(requestId)
      }
      for await (const frame of readFrames(response, maxFrameBytes, maxStreamBytes)) {
        if (outcome) throw invalidResponse()
        if (frame?.type === 'receipt' && exact(frame, ['type', 'receipt'])) {
          const receipt = verifyReceipt(frame.receipt, requestId)
          if (!admission && receipt.status === 'admitted') admission = receipt
          else if (admission && receipt.status !== 'admitted' && receipt.admittedAt === admission.admittedAt) outcome = receipt
          else throw invalidResponse()
        } else if (admission && ['delta', 'reply'].includes(frame?.type) && exact(frame, ['type', 'requestId', 'text'])
            && frame.requestId === requestId && typeof frame.text === 'string') {
          try { onEvent(Object.freeze(frame)) } catch { /* Reporting does not change the remote outcome. */ }
        } else throw invalidResponse()
      }
    } catch (cause) {
      if (cause?.code === 'worker-refused') throw cause
      outcome = undefined
    }
    if (outcome) return outcome
    return admission ? Object.freeze({ ...admission, status: 'unknown' }) : unknown(requestId)
  }

  return { create, submit, cancel, status }
}

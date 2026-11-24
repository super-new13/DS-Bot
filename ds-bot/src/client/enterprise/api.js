const prefix = '/api/enterprise/'
const terminalStatuses = new Set(['completed', 'aborted', 'failed'])
const unknownOutcome = 'worker-outcome-unknown'
const streamErrors = new Set(['not-authorized', 'queue-full', 'unavailable', unknownOutcome])
const validId = id => typeof id === 'string' && id.length <= 128 && id.trim() !== ''
const mediaType = response => response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()

export class EnterpriseApiError extends Error {
  constructor(code, { status, requestId } = {}) {
    super('Employee API request failed (' + code + ')')
    this.name = 'EnterpriseApiError'
    this.code = code
    this.status = status
    this.requestId = requestId
  }
}

function frameFrom(data, priorId) {
  let value
  try {
    value = JSON.parse(data)
  } catch {
    throw new EnterpriseApiError('invalid-stream', { requestId: priorId })
  }
  const { type, requestId, text, status, code } = value ?? {}
  if (validId(requestId) && (priorId === undefined ? type === 'queued' : requestId === priorId && type !== 'queued')) {
    if (type === 'queued') return { type, requestId }
    if ((type === 'delta' || type === 'reply') && typeof text === 'string') return { type, requestId, text }
    if (type === 'done' && terminalStatuses.has(status)) return { type, requestId, status }
    if (type === 'error' && streamErrors.has(code)) return { type, requestId, code }
  }
  throw new EnterpriseApiError('invalid-stream', { requestId: priorId })
}

async function readChat(response, { maxFrameBytes, maxStreamBytes, signal, onEvent }) {
  if (mediaType(response) !== 'text/event-stream' || !response.body) {
    void response.body?.cancel().catch(() => {})
    throw new EnterpriseApiError('invalid-stream')
  }
  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  const line = new Uint8Array(maxFrameBytes)
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let firstLine = true
  let afterCR = false
  let length = 0
  let frameBytes = 0
  let streamBytes = 0
  let data = ''
  let hasData = false
  let requestId
  const fail = code => new EnterpriseApiError(code, { requestId })
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      if (signal.aborted) throw fail('aborted')
      let chunk
      try {
        chunk = await reader.read()
      } catch {
        throw fail(signal.aborted ? 'aborted' : 'incomplete-stream')
      }
      if (signal.aborted) throw fail('aborted')
      if (chunk.done) throw fail('incomplete-stream')
      for (const byte of chunk.value) {
        if (++streamBytes > maxStreamBytes) throw fail('stream-too-large')
        const skipLF = afterCR && byte === 10
        afterCR = byte === 13
        if (skipLF) continue
        if (++frameBytes > maxFrameBytes) throw fail('frame-too-large')
        if (byte !== 10 && byte !== 13) {
          line[length++] = byte
          continue
        }
        let field
        try {
          field = decoder.decode(line.subarray(0, length))
        } catch {
          throw fail('invalid-stream')
        }
        if (firstLine) field = field.replace(/^\uFEFF/, '')
        firstLine = false
        length = 0
        if (field === '') {
          frameBytes = 0
          if (!hasData) continue
          const event = Object.freeze(frameFrom(data, requestId))
          data = ''
          hasData = false
          requestId = event.requestId
          const terminal = event.type === 'done' || event.type === 'error'
          if (onEvent) await onEvent(event)
          if (signal.aborted) throw fail('aborted')
          if (terminal) return event
        } else if (field === 'data' || field.startsWith('data:')) {
          if (hasData) data += '\n'
          data += field.slice(5).replace(/^ /, '')
          hasData = true
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
    reader.releaseLock()
  }
}

async function json(response) {
  if (mediaType(response) !== 'application/json') {
    void response.body?.cancel().catch(() => {})
    throw new EnterpriseApiError('invalid-response')
  }
  try {
    return await response.json()
  } catch {
    throw new EnterpriseApiError('invalid-response')
  }
}

function groupPath(roomId, operation) {
  if (typeof roomId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(roomId)) throw new EnterpriseApiError('invalid-room')
  return 'group-chat/' + roomId + '/' + operation
}

export function createEmployeeApi({ fetch: fetchRequest = (...args) => globalThis.fetch(...args),
  maxFrameBytes = 256 * 1024, maxStreamBytes = 16 * 1024 * 1024 } = {}) {
  if (![maxFrameBytes, maxStreamBytes].every(bytes => Number.isSafeInteger(bytes) && bytes > 0)) throw new TypeError('Invalid employee stream limits')
  const privateStreams = new Set()
  async function request(path, { method = 'GET', body, signal, accept = 'application/json' } = {}) {
    if (signal?.aborted) throw new EnterpriseApiError('aborted')
    try {
      return await fetchRequest(prefix + path, {
        method, mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
        headers: body === undefined ? { Accept: accept } : { Accept: accept, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw new EnterpriseApiError(signal?.aborted ? 'aborted' : 'network-error')
    }
  }

  function expect(response, status) {
    if (response.status === status) return response
    void response.body?.cancel().catch(() => {})
    throw new EnterpriseApiError(response.ok ? 'invalid-response' : 'http-error', { status: response.status })
  }

  const post = (path, body, signal) => request(path, { method: 'POST', body, signal })

  async function sendPrivate(botId, text, { signal, onEvent } = {}) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    privateStreams.add(controller)
    try {
      const response = expect(await request('private-chat/send', {
        method: 'POST', body: { botId, text }, signal: controller.signal, accept: 'text/event-stream',
      }), 200)
      return await readChat(response, { maxFrameBytes, maxStreamBytes, signal: controller.signal, onEvent })
    } finally {
      privateStreams.delete(controller)
      signal?.removeEventListener('abort', abort)
    }
  }

  return {
    async redeemInvite(token, password, { signal } = {}) { expect(await post('auth/redeem', { token, password }, signal), 204) },
    async login(personId, password, { signal } = {}) { expect(await post('auth/login', { personId, password }, signal), 204) },
    async logout({ signal } = {}) {
      expect(await post('auth/logout', undefined, signal), 204)
      for (const controller of privateStreams) controller.abort()
    },
    async currentSession({ signal } = {}) {
      const response = await request('auth/session', { signal })
      if (response.status === 401) {
        void response.body?.cancel().catch(() => {})
        return null
      }
      const session = await json(expect(response, 200))
      if (!validId(session?.personId)) throw new EnterpriseApiError('invalid-response')
      return { personId: session.personId }
    },
    sendPrivate,
    async cancelPrivate(botId, requestId, { signal } = {}) {
      const response = await post('private-chat/cancel', { botId, requestId }, signal)
      if (response.status === 503) {
        const failure = await json(response).catch(() => undefined)
        throw new EnterpriseApiError(failure?.error === unknownOutcome ? unknownOutcome : 'http-error', { status: 503, requestId })
      }
      const result = await json(expect(response, 202))
      if (result?.accepted !== true) throw new EnterpriseApiError('invalid-response')
      return { accepted: true }
    },
    async listRooms({ signal } = {}) {
      const result = await json(expect(await request('group-chat/rooms', { signal }), 200))
      if (!Array.isArray(result?.rooms) || result.rooms.some(room => typeof room?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(room.id))) {
        throw new EnterpriseApiError('invalid-response')
      }
      return result.rooms.map(({ id }) => ({ id }))
    },
    async groupHistory(roomId, { signal } = {}) {
      const history = await json(expect(await request(groupPath(roomId, 'history'), { signal }), 200))
      if (history?.roomId !== roomId || !Array.isArray(history.messages)) throw new EnterpriseApiError('invalid-response')
      return history
    },
    async sendGroup(roomId, text, { signal } = {}) {
      const result = await json(expect(await post(groupPath(roomId, 'send'), { text }, signal), 202))
      if (!validId(result?.requestId)) throw new EnterpriseApiError('invalid-response')
      return { requestId: result.requestId }
    },
  }
}

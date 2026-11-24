import { randomUUID } from 'node:crypto'

const scopeFields = ['nodeId', 'botId', 'personId', 'sessionId']
const terminal = new Set(['completed', 'aborted', 'failed'])
const validId = value => typeof value === 'string' && value.length <= 256 && value.trim() !== ''
const validDigest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const validTime = value => Number.isSafeInteger(value) && value >= 0
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const refused = () => Object.assign(new Error('Worker receipt operation refused'), { code: 'not-authorized' })
const conflict = () => Object.assign(new Error('Worker receipt conflict'), { code: 'receipt-conflict' })
const invalidStore = () => Object.assign(new Error('Invalid worker receipt state'), { code: 'invalid-receipt-state' })

function scopeOf(input) {
  const scope = {}
  for (const field of scopeFields) {
    if (!Object.hasOwn(input ?? {}, field) || !validId(input[field])) throw refused()
    scope[field] = input[field]
  }
  return scope
}

function sameScope(left, right) {
  return scopeFields.every(field => Object.hasOwn(left, field) && left[field] === right[field])
}

function checkState(state) {
  if (!isRecord(state) || state.version !== 1 || !(state.generation === null || validId(state.generation))
      || !isRecord(state.receipts)) throw invalidStore()
}

function storedReceipt(state, key) {
  if (!Object.hasOwn(state.receipts, key)) return undefined
  const record = state.receipts[key]
  if (!isRecord(record) || !isRecord(record.scope)
      || !scopeFields.every(field => Object.hasOwn(record.scope, field) && validId(record.scope[field]))
      || !validDigest(record.inputDigest) || !validId(record.generation) || !validTime(record.admittedAt)
      || (record.status === 'admitted' ? Object.hasOwn(record, 'finishedAt')
        : !terminal.has(record.status) || !validTime(record.finishedAt) || record.finishedAt < record.admittedAt)) {
    throw invalidStore()
  }
  return record
}

function view(requestId, record, generation) {
  const status = record.status === 'admitted' && record.generation !== generation ? 'unknown' : record.status
  return {
    requestId, status, admittedAt: record.admittedAt,
    ...(terminal.has(status) ? { finishedAt: record.finishedAt } : {}),
  }
}

// The host must resolve and authorize the scope before calling this service.
// The store starts as { version: 1, generation: null, receipts: {} }. It must
// serialize synchronous transaction callbacks and resolve only after commit.
// Open once per worker start. The new generation fences writers from before a
// restart. Existing receipts remain available, including uncertain admissions.
export async function openWorkerReceipts({ read, transact, now = Date.now }) {
  if ([read, transact, now].some(value => typeof value !== 'function')) throw new TypeError('Worker receipts require atomic storage and a clock')
  const generation = randomUUID()
  await transact(state => {
    checkState(state)
    state.generation = generation
  })

  function keyOf(requestId) {
    if (!validId(requestId)) throw refused()
    return 'request:' + requestId
  }

  function time() {
    const current = now()
    if (!validTime(current)) throw new RangeError('Invalid worker receipt time')
    return current
  }

  async function admit(inputScope, requestId, inputDigest) {
    const scope = scopeOf(inputScope)
    const key = keyOf(requestId)
    if (!validDigest(inputDigest)) throw new TypeError('Expected a canonical SHA-256 request digest')
    return transact(state => {
      checkState(state)
      if (state.generation !== generation) throw refused()
      const existing = storedReceipt(state, key)
      if (existing) {
        if (!sameScope(existing.scope, scope)) throw refused()
        if (existing.inputDigest !== inputDigest) throw conflict()
        return { admitted: false, receipt: view(requestId, existing, generation) }
      }
      const record = { scope, inputDigest, generation, status: 'admitted', admittedAt: time() }
      state.receipts[key] = record
      return { admitted: true, receipt: view(requestId, record, generation) }
    })
  }

  async function lookup(inputScope, requestId) {
    const scope = scopeOf(inputScope)
    const key = keyOf(requestId)
    const state = await read()
    checkState(state)
    const record = storedReceipt(state, key)
    if (!record || !sameScope(record.scope, scope)) return undefined
    return view(requestId, record, state.generation)
  }

  async function finish(inputScope, requestId, status) {
    const scope = scopeOf(inputScope)
    const key = keyOf(requestId)
    if (!terminal.has(status)) throw new TypeError('Expected a terminal worker status')
    return transact(state => {
      checkState(state)
      const record = storedReceipt(state, key)
      if (state.generation !== generation || !record || !sameScope(record.scope, scope)) throw refused()
      if (terminal.has(record.status)) {
        if (record.status !== status) throw conflict()
        return view(requestId, record, generation)
      }
      if (record.generation !== generation) throw refused()
      record.status = status
      record.finishedAt = Math.max(record.admittedAt, time())
      return view(requestId, record, generation)
    })
  }

  return { admit, lookup, finish }
}

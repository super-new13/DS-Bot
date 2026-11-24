import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

const occupied = new Set()
const scopeIds = ['nodeId', 'personId', 'botId', 'sessionId', 'requestId', 'dispatchId', 'targetId', 'ruleId', 'ruleVersion']
const scopeFields = [...scopeIds, 'roomId', 'operation', 'version', 'contentDigest']
const statuses = new Set(['completed', 'cancelled', 'fenced'])
const operations = new Set(['read', 'create', 'modify'])
const invalid = () => Object.assign(new Error('Invalid file settlement evidence'), { code: 'invalid-settlement-evidence' })
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, fields) => record(value) && Object.keys(value).length === fields.length
  && fields.every(field => Object.hasOwn(value, field))

function validate(input) {
  if (!exact(input, ['scope', 'status', 'evidenceId']) || !id(input.evidenceId)
      || !statuses.has(input.status) || !exact(input.scope, scopeFields)) throw invalid()
  const scope = Object.freeze(Object.fromEntries(scopeFields.map(field => [field, input.scope[field]])))
  const { roomId, operation, version, contentDigest } = scope
  if (!scopeIds.every(field => id(scope[field])) || !(roomId === null || id(roomId)) || !operations.has(operation)
      || !(operation === 'create' ? version === null : typeof version === 'string' && version.length <= 512 && version.trim() !== '')
      || !(operation === 'read' ? contentDigest === null : typeof contentDigest === 'string' && /^[0-9a-f]{64}$/.test(contentDigest))) throw invalid()
  return Object.freeze({ scope, status: input.status, evidenceId: input.evidenceId })
}

const dispatchKey = ({ scope }) => JSON.stringify([scope.nodeId, scope.requestId, scope.dispatchId])
const evidenceKey = ({ scope, evidenceId }) => JSON.stringify([scope.nodeId, evidenceId])
const sameEvidence = (left, right) => left.evidenceId === right.evidenceId && left.status === right.status
  && scopeFields.every(field => left.scope[field] === right.scope[field])

function decode(bytes) {
  let state
  try { state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw invalid() }
  if (!exact(state, ['version', 'entries']) || state.version !== 1 || !Array.isArray(state.entries)) throw invalid()
  const dispatches = new Set()
  const byEvidence = new Map()
  for (const input of state.entries) {
    const entry = validate(input)
    const dispatch = dispatchKey(entry)
    const key = evidenceKey(entry)
    if (dispatches.has(dispatch) || byEvidence.has(key)) throw invalid()
    dispatches.add(dispatch)
    byEvidence.set(key, entry)
  }
  return { state, byEvidence }
}

// One service owns this private local POSIX directory. Only the independent
// evidence producer holds the ingestion capability. Network handlers receive
// verifySettlement alone and cannot turn a settlement claim into evidence.
export async function openFileSettlementEvidence(file, { trustedProducer, initialize = false, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (typeof trustedProducer !== 'symbol' || typeof file !== 'string' || !isAbsolute(file) || typeof initialize !== 'boolean'
      || !Number.isSafeInteger(maxBytes) || maxBytes < 64 || maxBytes > 64 * 1024 * 1024
      || typeof process.getuid !== 'function') throw invalid()
  const parent = await realpath(dirname(file))
  const path = join(parent, basename(file))
  const uid = process.getuid()
  if (occupied.has(path)) throw invalid()
  occupied.add(path)
  let tail = Promise.resolve()
  let closed = false
  let uncertain = false

  async function openDirectory() {
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const stat = await directory.stat()
      if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw invalid()
      return directory
    } catch (error) {
      await directory.close()
      throw error
    }
  }

  async function load() {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) throw invalid()
      const bytes = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length !== stat.size) throw invalid()
      return decode(bytes.subarray(0, length))
    } finally { await handle.close() }
  }

  async function commit(state, create = false) {
    const text = JSON.stringify(state) + String.fromCharCode(10)
    if (Buffer.byteLength(text) > maxBytes) throw Object.assign(new Error('File settlement evidence storage limit reached'), { code: 'settlement-evidence-full' })
    const directory = await openDirectory()
    const temporary = join(parent, '.file-settlement-evidence-' + randomUUID() + '.tmp')
    let published = false
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(text, 'utf8')
        await handle.sync()
      } finally { await handle.close() }
      if (create) await link(temporary, path)
      else await rename(temporary, path)
      published = true
      if (create) await unlink(temporary)
      await directory.sync()
    } catch (error) {
      if (published) uncertain = true
      await unlink(temporary).catch(() => {})
      throw error
    } finally { await directory.close() }
  }

  try {
    const directory = await openDirectory()
    await directory.close()
    try { await load() } catch (error) {
      if (!initialize || error.code !== 'ENOENT') throw error
      await commit({ version: 1, entries: [] }, true)
    }
  } catch (error) {
    occupied.delete(path)
    throw error
  }

  function enqueue(operation) {
    if (closed) throw invalid()
    const next = tail.then(async () => {
      if (uncertain) throw invalid()
      return operation(await load())
    })
    tail = next.catch(() => {})
    return next
  }

  async function ingest(producer, input) {
    if (producer !== trustedProducer) throw Object.assign(new Error('Settlement evidence producer refused'), { code: 'not-authorized' })
    const entry = validate(input)
    return enqueue(async ({ state, byEvidence }) => {
      const existing = byEvidence.get(evidenceKey(entry))
      if (existing && sameEvidence(existing, entry)) return { inserted: false }
      if (existing || state.entries.some(candidate => dispatchKey(candidate) === dispatchKey(entry))) {
        throw Object.assign(new Error('Conflicting settlement evidence'), { code: 'settlement-evidence-conflict' })
      }
      state.entries.push(entry)
      await commit(state)
      return { inserted: true }
    })
  }

  async function verifySettlement(nodeId, input, { signal } = {}) {
    try {
      if (!id(nodeId) || signal?.aborted) return false
      const entry = validate(input)
      if (entry.scope.nodeId !== nodeId) return false
      return await enqueue(({ byEvidence }) => {
        const existing = byEvidence.get(evidenceKey(entry))
        return !signal?.aborted && existing !== undefined && sameEvidence(existing, entry)
      })
    } catch { return false }
  }

  let closing
  function close() {
    closed = true
    return closing ??= tail.then(() => { occupied.delete(path) })
  }

  return { ingest, verifySettlement, close }
}

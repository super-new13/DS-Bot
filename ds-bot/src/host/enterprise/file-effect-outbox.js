import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

const occupied = new Set()
const scopeIds = ['nodeId', 'personId', 'botId', 'sessionId', 'requestId', 'dispatchId', 'targetId', 'ruleId', 'ruleVersion']
const scopeFields = [...scopeIds, 'roomId', 'operation', 'version', 'contentDigest']
const operations = new Set(['read', 'create', 'modify'])
const invalid = () => Object.assign(new Error('Invalid file effect outbox'), { code: 'invalid-effect-outbox' })
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, fields) => record(value) && Object.keys(value).length === fields.length
  && fields.every(field => Object.hasOwn(value, field))

function entryOf(input) {
  if (!exact(input, ['scope', 'status']) || input.status !== 'completed' || !exact(input.scope, scopeFields)) throw invalid()
  const scope = Object.freeze(Object.fromEntries(scopeFields.map(field => [field, input.scope[field]])))
  const { roomId, operation, version, contentDigest } = scope
  if (!scopeIds.every(field => id(scope[field])) || !(roomId === null || id(roomId)) || !operations.has(operation)
      || !(operation === 'create' ? version === null : typeof version === 'string' && version.length <= 512 && version.trim() !== '')
      || !(operation === 'read' ? contentDigest === null : typeof contentDigest === 'string' && /^[0-9a-f]{64}$/.test(contentDigest))) throw invalid()
  const key = JSON.stringify([scope.nodeId, scope.requestId, scope.dispatchId])
  const evidenceId = 'effect-' + createHash('sha256').update(key).digest('hex')
  return Object.freeze({ scope, status: 'completed', evidenceId })
}

function decode(bytes) {
  let state
  try { state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw invalid() }
  if (!exact(state, ['version', 'entries']) || state.version !== 1 || !Array.isArray(state.entries)) throw invalid()
  const ids = new Set()
  const entries = state.entries.map(input => {
    if (!exact(input, ['scope', 'status', 'evidenceId'])) throw invalid()
    const entry = entryOf({ scope: input.scope, status: input.status })
    if (entry.evidenceId !== input.evidenceId || ids.has(entry.evidenceId)) throw invalid()
    ids.add(entry.evidenceId)
    return entry
  })
  return { version: 1, entries }
}

// One service writer owns the private local POSIX directory. Give onCompleted
// only to the guarded executor. The trusted ingestion callback acknowledges
// durable ingestion with { inserted: true } or an exact duplicate with false.
export async function openFileEffectOutbox(file, { initialize = false, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (typeof file !== 'string' || !isAbsolute(file) || typeof initialize !== 'boolean'
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
    if (Buffer.byteLength(text) > maxBytes) throw Object.assign(new Error('File effect outbox storage limit reached'), { code: 'effect-outbox-full' })
    const directory = await openDirectory()
    const temporary = join(parent, '.file-effect-outbox-' + randomUUID() + '.tmp')
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

  async function onCompleted(input) {
    const entry = entryOf(input)
    return enqueue(async state => {
      const previous = state.entries.find(item => item.evidenceId === entry.evidenceId)
      if (previous) {
        if (!scopeFields.every(field => previous.scope[field] === entry.scope[field])) throw invalid()
        return { inserted: false }
      }
      state.entries.push(entry)
      await commit(state)
      return { inserted: true }
    })
  }

  let draining
  async function drain(ingest, { limit = 20, timeoutMs = 5000 } = {}) {
    if (closed || draining || typeof ingest !== 'function' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw invalid()
    draining = deliver(ingest, limit, timeoutMs)
    try { return await draining } finally { draining = undefined }
  }

  async function deliver(ingest, limit, timeoutMs) {
    const batch = await enqueue(state => state.entries.slice(0, limit))
    if (!batch.length) return { acknowledged: 0 }
    let acknowledged = 0
    const deadline = new AbortController()
    let timer
    const expired = new Promise(resolve => {
      timer = setTimeout(() => { deadline.abort(); resolve(undefined) }, timeoutMs)
    })
    try {
      for (const entry of batch) {
        if (closed || deadline.signal.aborted) break
        const reply = await Promise.race([expired, Promise.resolve().then(() => ingest(entry, { signal: deadline.signal }))])
        const inserted = exact(reply, ['inserted']) ? Object.getOwnPropertyDescriptor(reply, 'inserted')?.value : undefined
        if (closed || deadline.signal.aborted || typeof inserted !== 'boolean') break
        await enqueue(async state => {
          state.entries = state.entries.filter(item => item.evidenceId !== entry.evidenceId)
          await commit(state)
        })
        acknowledged += 1
      }
      return { acknowledged }
    } finally { clearTimeout(timer) }
  }

  let closing
  function close() {
    closed = true
    return closing ??= Promise.allSettled([draining, tail]).then(() => { occupied.delete(path) })
  }

  return { onCompleted, drain, close }
}

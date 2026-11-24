import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

const occupied = new Set()
const scopeIds = ['nodeId', 'personId', 'botId', 'sessionId', 'requestId', 'dispatchId', 'targetId', 'ruleId', 'ruleVersion']
const scopeFields = [...scopeIds, 'roomId', 'operation', 'version', 'contentDigest']
const statuses = new Set(['reserved', 'completed', 'cancelled', 'fenced'])
const operations = new Set(['read', 'create', 'modify'])
const invalid = () => Object.assign(new Error('Invalid file reservation state'), { code: 'invalid-file-reservation-state' })
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, fields) => record(value) && Object.keys(value).length === fields.length
  && fields.every(field => Object.hasOwn(value, field))

function decode(bytes) {
  let state
  try { state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw invalid() }
  if (!exact(state, ['version', 'revocations', 'reservations']) || state.version !== 1
      || !record(state.revocations) || !record(state.reservations)) throw invalid()
  for (const [personId, revoked] of Object.entries(state.revocations)) {
    if (!id(personId) || revoked !== true) throw invalid()
  }
  for (const [key, entry] of Object.entries(state.reservations)) {
    if (!exact(entry, ['scope', 'status']) || !statuses.has(entry.status) || !exact(entry.scope, scopeFields)) throw invalid()
    const scope = entry.scope
    const { roomId, operation, version, contentDigest } = scope
    if (!scopeIds.every(field => id(scope[field])) || !(roomId === null || id(roomId)) || !operations.has(operation)
        || !(operation === 'create' ? version === null : typeof version === 'string' && version.length <= 512 && version.trim() !== '')
        || !(operation === 'read' ? contentDigest === null : typeof contentDigest === 'string' && /^[a-f0-9]{64}$/.test(contentDigest))
        || key !== JSON.stringify([scope.nodeId, scope.requestId, scope.dispatchId])) throw invalid()
  }
  return state
}

// One service writer owns this file and its private local POSIX directory.
export async function openFileReservationStore(file, { initialize = false, maxBytes = 8 * 1024 * 1024 } = {}) {
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
    if (Buffer.byteLength(text) > maxBytes) throw Object.assign(new Error('File reservation storage limit reached'), { code: 'file-reservation-store-full' })
    const directory = await openDirectory()
    const temporary = join(parent, '.file-reservations-' + randomUUID() + '.tmp')
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
      await commit({ version: 1, revocations: {}, reservations: {} }, true)
    }
  } catch (error) {
    occupied.delete(path)
    throw error
  }

  async function transact(change) {
    if (closed || typeof change !== 'function') throw invalid()
    const operation = tail.then(async () => {
      if (uncertain) throw invalid()
      const draft = await load()
      const result = change(draft)
      if (typeof result?.then === 'function') {
        void Promise.resolve(result).catch(() => {})
        throw new TypeError('File reservation transactions require a synchronous callback')
      }
      const body = Buffer.from(JSON.stringify(draft))
      const validated = decode(body)
      await commit(validated)
      return result
    })
    tail = operation.catch(() => {})
    return operation
  }

  let closing
  function close() {
    closed = true
    return closing ??= tail.then(() => { occupied.delete(path) })
  }

  return { transact, close }
}

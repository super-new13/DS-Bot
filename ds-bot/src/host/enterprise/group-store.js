import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const text = value => typeof value === 'string' && value.trim() !== ''
const exact = (value, ...keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const stateError = (code, message) => Object.assign(new Error(message), { code })
const invalid = () => stateError('invalid-group-transcript', 'Invalid room transcript')

function batchOf(batch, roomId) {
  if (!exact(batch, 'requestId', 'rows') || !id(batch.requestId) || !Array.isArray(batch.rows)
      || batch.rows.length < 1 || batch.rows.length > 2) throw invalid()
  const rows = Array.from(batch.rows, (row, index) => {
    if (!exact(row, 'roomId', 'kind', 'text', 'by', 'name') || row.roomId !== roomId
        || row.kind !== (index === 0 ? 'user' : 'bot') || !id(row.by) || !text(row.name) || !text(row.text)) throw invalid()
    return { roomId, kind: row.kind, text: row.text, by: row.by, name: row.name }
  })
  return { requestId: batch.requestId, rows }
}

function decode(bytes, roomId) {
  let snapshot
  try { snapshot = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw invalid() }
  if (!exact(snapshot, 'version', 'roomId', 'batches') || snapshot.version !== 1 || snapshot.roomId !== roomId
      || !Array.isArray(snapshot.batches)) throw invalid()
  const seen = new Set()
  const batches = snapshot.batches.map(value => {
    const batch = batchOf(value, roomId)
    if (seen.has(batch.requestId)) throw invalid()
    seen.add(batch.requestId)
    return batch
  })
  return { version: 1, roomId, batches }
}

// Provision a private directory on a local POSIX filesystem and assign it to
// one service writer. Request IDs deduplicate appends within their room.
export async function openEmployeeGroupStore(path, { maxRoomBytes = 8 * 1024 * 1024 } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || !Number.isSafeInteger(maxRoomBytes)
      || maxRoomBytes < 1 || maxRoomBytes > 64 * 1024 * 1024) throw new TypeError('Invalid group store configuration')
  const root = await realpath(path)
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY)
  await directory.close()
  let tail = Promise.resolve()
  let uncertain = false

  function enqueue(operation) {
    const next = tail.then(() => {
      if (uncertain) throw stateError('group-commit-uncertain', 'Room transcript commit outcome is uncertain')
      return operation()
    })
    tail = next.catch(() => {})
    return next
  }

  // Fixed-length lowercase filenames preserve exact IDs on case-insensitive volumes.
  const roomFile = roomId => join(root, 'room-' + createHash('sha256').update(roomId).digest('hex') + '.json')

  async function load(roomId) {
    let file
    try { file = await open(roomFile(roomId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, roomId, batches: [] }
      throw error
    }
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > maxRoomBytes) throw invalid()
      const bytes = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length !== stat.size) throw invalid()
      return decode(bytes.subarray(0, length), roomId)
    } finally { await file.close() }
  }

  async function commit(roomId, body) {
    const temporary = join(root, '.group-transcript-' + randomUUID() + '.tmp')
    const file = await open(temporary, 'wx', 0o600)
    let published = false
    try {
      try {
        await file.writeFile(body, 'utf8')
        await file.sync()
      } finally { await file.close() }
      await rename(temporary, roomFile(roomId))
      published = true
      const parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY)
      try { await parent.sync() } finally { await parent.close() }
    } catch (error) {
      if (published) uncertain = true
      else await unlink(temporary).catch(() => {})
      throw error
    }
  }

  async function append(roomId, input) {
    if (!id(roomId)) throw invalid()
    const batch = batchOf(input, roomId)
    return enqueue(async () => {
      const snapshot = await load(roomId)
      const previous = snapshot.batches.find(value => value.requestId === batch.requestId)
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(batch)) throw stateError('group-request-conflict', 'Room request already committed')
        return { appended: false }
      }
      snapshot.batches.push(batch)
      const body = JSON.stringify(snapshot) + String.fromCharCode(10)
      if (Buffer.byteLength(body) > maxRoomBytes) throw stateError('group-transcript-full', 'Room transcript limit reached')
      await commit(roomId, body)
      return { appended: true }
    })
  }

  async function readTail(roomId, { limit = 100, signal } = {}) {
    if (!id(roomId) || !Number.isSafeInteger(limit) || limit < 1) throw invalid()
    return enqueue(async () => {
      signal?.throwIfAborted()
      const { batches } = await load(roomId)
      signal?.throwIfAborted()
      const size = Math.min(limit, 100)
      return batches.slice(-size).flatMap(batch => batch.rows).slice(-size)
    })
  }

  return { append, readTail }
}

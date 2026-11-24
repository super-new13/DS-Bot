import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

const common = ['type', 'personId', 'botId', 'roomId', 'sessionId', 'requestId', 'dispatchId', 'operation', 'ruleId', 'ruleVersion', 'verdict']
const occupied = new Set()
const invalid = () => Object.assign(new Error('Invalid file audit storage or event'), { code: 'invalid-file-audit' })
const id = value => typeof value === 'string' && value.length <= 256 && value.trim() !== ''

function validate(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw invalid()
  const values = Object.getOwnPropertyDescriptors(event)
  const type = values.type?.value
  const effect = type === 'file-effect'
  const keys = effect ? [...common, 'outcome'] : common
  if ((!effect && type !== 'file-authorization') || Reflect.ownKeys(values).length !== keys.length
      || !keys.every(key => Object.hasOwn(values, key) && Object.hasOwn(values[key], 'value'))) throw invalid()
  const copy = Object.fromEntries(keys.map(key => [key, values[key].value]))
  const { personId, botId, roomId, sessionId, requestId, dispatchId, operation, ruleId, ruleVersion, verdict, outcome } = copy
  if (![personId, botId, sessionId, requestId, dispatchId].every(id) || !(roomId === null || id(roomId))
      || !['create', 'modify', 'read'].includes(operation) || !['allowed', 'denied'].includes(verdict)
      || (!(id(ruleId) && id(ruleVersion)) && !(verdict === 'denied' && ruleId === null && ruleVersion === null))
      || (effect && (verdict !== 'allowed' || !['completed', 'failed', 'unknown'].includes(outcome)))) throw invalid()
  return copy
}

function decode(bytes) {
  let state
  try { state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw invalid() }
  if (!state || state.version !== 1 || !Array.isArray(state.events) || Object.keys(state).length !== 2) throw invalid()
  return { version: 1, events: state.events.map(validate) }
}

// One service writer owns this file and its private local POSIX directory.
export async function openFileAuditStore(file, { initialize = false, maxBytes = 8 * 1024 * 1024 } = {}) {
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
    if (Buffer.byteLength(text) > maxBytes) throw Object.assign(new Error('File audit storage limit reached'), { code: 'file-audit-full' })
    const directory = await openDirectory()
    const temporary = join(parent, '.file-audit-' + randomUUID() + '.tmp')
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
      await commit({ version: 1, events: [] }, true)
    }
  } catch (error) {
    occupied.delete(path)
    throw error
  }

  async function writeAudit(event) {
    if (closed) throw invalid()
    const copy = validate(event)
    const operation = tail.then(async () => {
      if (uncertain) throw invalid()
      const state = await load()
      state.events.push(copy)
      await commit(state)
    })
    tail = operation.catch(() => {})
    return operation
  }

  let closing
  function close() {
    closed = true
    return closing ??= tail.then(() => { occupied.delete(path) })
  }

  return { writeAudit, close }
}

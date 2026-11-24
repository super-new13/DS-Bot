import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, open, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const scopeFields = ['nodeId', 'personId', 'botId']
const roomFields = ['nodeId', 'botId', 'roomId']
const fieldsFor = scope => Object.hasOwn(scope ?? {}, 'roomId') ? roomFields : scopeFields
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
const error = (code, message) => Object.assign(new Error(message), { code })
const invalid = () => error('invalid-session-mapping', 'Invalid worker session mapping')
const refused = () => error('not-authorized', 'Worker session mapping refused')
const scopeKey = ({ nodeId, personId, botId, roomId }) => JSON.stringify(roomId === undefined
  ? [nodeId, personId, botId] : ['room', nodeId, botId, roomId])
const nativeKey = ({ nodeId, sessionId }) => JSON.stringify([nodeId, sessionId])

function fieldsOf(value, fields) {
  const result = {}
  for (const key of fields) {
    if (!Object.hasOwn(value ?? {}, key) || !validId(value[key])) throw refused()
    result[key] = value[key]
  }
  return result
}

function decode(text) {
  let state
  try { state = JSON.parse(text) } catch { throw invalid() }
  if (state?.version !== 1 || !Array.isArray(state.bindings) || Object.keys(state).length !== 2) throw invalid()
  const scopes = new Map()
  const sessions = new Set()
  for (const binding of state.bindings) {
    const bindingFields = [...fieldsFor(binding), 'sessionId']
    if (!binding || Object.keys(binding).length !== bindingFields.length
        || !bindingFields.every(key => Object.hasOwn(binding, key) && validId(binding[key]))) throw invalid()
    const key = scopeKey(binding)
    const native = nativeKey(binding)
    if (scopes.has(key) || sessions.has(native)) throw invalid()
    scopes.set(key, Object.freeze(binding))
    sessions.add(native)
  }
  return { state, scopes, sessions }
}

// Use one instance per file in a private directory on a local POSIX filesystem.
// Scope and Session IDs must come from the authorized host and worker, respectively.
export async function openWorkerSessionMapping(file, { initialize = false } = {}) {
  const path = resolve(file)
  const parent = dirname(path)
  let tail = Promise.resolve()
  let uncertain = false

  async function load() {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!(await handle.stat()).isFile()) throw invalid()
      return decode(await handle.readFile('utf8'))
    } finally {
      await handle.close()
    }
  }

  async function commit(state, create = false) {
    const temporary = join(parent, '.worker-sessions-' + randomUUID() + '.tmp')
    const handle = await open(temporary, 'wx', 0o600)
    let published = false
    try {
      try {
        await handle.writeFile(JSON.stringify(state) + '\n', 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (create) await link(temporary, path)
      else await rename(temporary, path)
      published = true
      if (create) await unlink(temporary)
      const directory = await open(parent, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch (cause) {
      if (published) uncertain = true
      await unlink(temporary).catch(() => {})
      throw cause
    }
  }

  try { await load() } catch (cause) {
    if (!initialize || cause.code !== 'ENOENT') throw cause
    await commit({ version: 1, bindings: [] }, true)
  }

  function enqueue(operation) {
    const pending = tail.then(() => {
      if (uncertain) throw error('session-mapping-uncertain', 'Worker session mapping commit outcome is uncertain')
      return operation()
    })
    tail = pending.catch(() => {})
    return pending
  }

  async function lookup(scope) {
    const key = scopeKey(fieldsOf(scope, fieldsFor(scope)))
    return enqueue(async () => (await load()).scopes.get(key))
  }

  async function owns(input) {
    const binding = fieldsOf(input, [...fieldsFor(input), 'sessionId'])
    return (await lookup(binding))?.sessionId === binding.sessionId
  }

  async function bind(input) {
    const binding = Object.freeze(fieldsOf(input, [...fieldsFor(input), 'sessionId']))
    return enqueue(async () => {
      const { state, scopes, sessions } = await load()
      const existing = scopes.get(scopeKey(binding))
      if (existing?.sessionId === binding.sessionId) return existing
      if (existing || sessions.has(nativeKey(binding))) throw refused()
      state.bindings.push(binding)
      await commit(state)
      return binding
    })
  }

  return { lookup, owns, bind }
}

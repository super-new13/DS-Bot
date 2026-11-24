import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, open, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const scopeFields = ['nodeId', 'botId', 'personId', 'sessionId']
const terminal = new Set(['completed', 'aborted', 'failed'])
const id = value => typeof value === 'string' && value.length <= 256 && value.trim() !== ''
const time = value => Number.isSafeInteger(value) && value >= 0
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fields = (value, ...keys) => record(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key))
const invalid = () => Object.assign(new Error('Invalid worker receipt state'), { code: 'invalid-receipt-state' })

function decode(text) {
  let state
  try {
    state = JSON.parse(text)
  } catch {
    throw invalid()
  }
  if (!fields(state, 'version', 'generation', 'receipts') || state.version !== 1
      || !(state.generation === null || id(state.generation)) || !record(state.receipts)) throw invalid()

  for (const [key, receipt] of Object.entries(state.receipts)) {
    if (state.generation === null || !key.startsWith('request:') || !id(key.slice('request:'.length))) throw invalid()
    const common = ['scope', 'inputDigest', 'generation', 'status', 'admittedAt']
    const finished = terminal.has(receipt?.status)
    if (!fields(receipt, ...common, ...(finished ? ['finishedAt'] : []))
        || !(finished || receipt.status === 'admitted')
        || !fields(receipt.scope, ...scopeFields) || !scopeFields.every(key => id(receipt.scope[key]))
        || typeof receipt.inputDigest !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.inputDigest)
        || !id(receipt.generation) || !time(receipt.admittedAt)
        || (finished && (!time(receipt.finishedAt) || receipt.finishedAt < receipt.admittedAt))) throw invalid()
  }
  return state
}

// Open one store per worker process and file. The local POSIX filesystem and its
// pre-existing private parent directory must be exclusively managed by that worker.
export async function openWorkerReceiptStore(file, { initialize = false } = {}) {
  const path = resolve(file)
  const parent = dirname(path)
  let tail = Promise.resolve()
  let uncertain = false

  async function load() {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw invalid()
      return decode(await handle.readFile('utf8'))
    } finally {
      await handle.close()
    }
  }

  async function commit(text, create = false) {
    const temporary = join(parent, '.worker-receipts-' + randomUUID() + '.tmp')
    const handle = await open(temporary, 'wx', 0o600)
    let published = false
    try {
      try {
        await handle.writeFile(text + '\n', 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (create) await link(temporary, path)
      else await rename(temporary, path)
      published = true
      if (create) await unlink(temporary)
      const directory = await open(parent, 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch (error) {
      if (published) uncertain = true
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  try {
    await load()
  } catch (error) {
    if (error.code !== 'ENOENT' || !initialize) throw error
    await commit('{"version":1,"generation":null,"receipts":{}}', true)
  }

  function enqueue(operation) {
    const pending = tail.then(() => {
      if (uncertain) throw new Error('Worker receipt store commit outcome is uncertain')
      return operation()
    })
    tail = pending.catch(() => {})
    return pending
  }

  return {
    read: () => enqueue(load),
    transact: change => enqueue(async () => {
      const draft = await load()
      const result = change(draft)
      if (typeof result?.then === 'function') {
        void Promise.resolve(result).catch(() => {})
        throw new TypeError('Worker receipt transactions require a synchronous callback')
      }
      const text = JSON.stringify(draft)
      decode(text)
      await commit(text)
      return result
    }),
  }
}

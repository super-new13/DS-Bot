import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export const transcriptId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
export const maxTranscriptReplyBytes = 256 * 1024
const invalid = () => new TypeError('Invalid private transcript record')
const positive = value => Number.isSafeInteger(value) && value > 0
const string = value => typeof value === 'string' && value.length > 0
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const hash = value => createHash('sha256').update(value).digest('hex')
const encode = value => JSON.stringify(value) + '\n'
const statuses = new Set(['completed', 'failed', 'aborted', 'unknown'])

function turnValid(turn) {
  return exact(turn, ['requestId', 'at', 'text', 'replies', 'incomplete', 'status'])
    && transcriptId(turn.requestId) && positive(turn.at) && string(turn.text) && Array.isArray(turn.replies)
    && turn.replies.every(string) && typeof turn.incomplete === 'boolean' && (turn.status === null || statuses.has(turn.status))
}

// Run one instance per controller. The provisioned directory must be private.
export async function openEmployeeTranscriptStore(path, { maxBytes = 8 * 1024 * 1024 } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || !positive(maxBytes) || maxBytes > 64 * 1024 * 1024) throw invalid()
  const root = await realpath(path)
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY)
  await directory.close()
  let tail = Promise.resolve()
  let uncertain = false
  const gaps = new Set()

  function enqueue(operation) {
    const next = tail.then(operation)
    tail = next.catch(() => {})
    return next
  }

  function scopeOf({ personId, botId }) {
    if (!transcriptId(personId) || !transcriptId(botId)) throw invalid()
    const key = hash(JSON.stringify([personId, botId]))
    return { personId, botId, key, file: join(root, 'private-' + key + '.json'), gap: join(root, 'gap-' + key + '.json') }
  }

  async function load(filePath, limit) {
    let file
    try { file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > limit) throw invalid()
      const bytes = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length !== stat.size) throw invalid()
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
    } finally { await file.close() }
  }

  async function snapshot(scope) {
    const { personId, botId } = scope
    const saved = await load(scope.file, maxBytes)
    if (saved === undefined) return { version: 1, personId, botId, turns: [] }
    if (!exact(saved, ['version', 'personId', 'botId', 'turns']) || saved.version !== 1
        || saved.personId !== personId || saved.botId !== botId || !Array.isArray(saved.turns)
        || !saved.turns.every(turnValid) || new Set(saved.turns.map(turn => turn.requestId)).size !== saved.turns.length) throw invalid()
    return saved
  }

  async function commit(destination, body) {
    const temp = join(root, '.private-transcript-' + randomUUID() + '.tmp')
    const file = await open(temp, 'wx', 0o600)
    let published = false
    try {
      try {
        await file.writeFile(body, 'utf8')
        await file.sync()
      } finally { await file.close() }
      await rename(temp, destination)
      published = true
      const parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY)
      try { await parent.sync() } finally { await parent.close() }
    } catch (error) {
      if (published) uncertain = true
      else await unlink(temp).catch(() => {})
      throw error
    }
  }

  async function markIncomplete(scope) {
    const { personId, botId, key } = scopeOf(scope)
    return enqueue(async () => {
      const { gap } = scopeOf({ personId, botId })
      gaps.add(key)
      await commit(gap, encode({ personId, botId, incomplete: true }))
      gaps.delete(key)
    })
  }

  function mutate(input, change) {
    const scope = scopeOf(input)
    return enqueue(async () => {
      if (uncertain) throw invalid()
      const saved = await snapshot(scope)
      change(saved.turns)
      const body = encode(saved)
      if (Buffer.byteLength(body) > maxBytes) throw new Error('Private transcript storage limit reached')
      await commit(scope.file, body)
    })
  }

  async function begin(input) {
    const { requestId, text, at } = input
    const turn = { requestId, text, at, replies: [], status: null, incomplete: true }
    if (!turnValid(turn)) throw invalid()
    return mutate(input, turns => {
      if (turns.some(row => row.requestId === requestId)) throw invalid()
      turns.push(turn)
    })
  }

  async function finish(input) {
    const { requestId, replies, status, incomplete } = input
    if (!transcriptId(requestId) || !statuses.has(status) || !Array.isArray(replies) || !replies.every(string)
        || typeof incomplete !== 'boolean' || Buffer.byteLength(encode(replies)) > maxTranscriptReplyBytes) throw invalid()
    const replyTexts = replies.slice()
    return mutate(input, turns => {
      const turn = turns.find(row => row.requestId === requestId)
      if (!turn || turn.status !== null) throw invalid()
      Object.assign(turn, { replies: replyTexts, status, incomplete: incomplete || status === 'unknown' })
    })
  }

  async function readAudited(input) {
    const scope = scopeOf(input)
    const { personId, botId, key, gap } = scope
    const { ownerRequestId, at, limit, before, signal } = input
    if (!transcriptId(ownerRequestId) || !positive(at) || !positive(limit) || limit > 50
        || (before !== undefined && !positive(before))) throw invalid()
    return enqueue(async () => {
      signal?.throwIfAborted()
      if (uncertain) throw invalid()
      await commit(join(root, 'owner-read-' + hash(ownerRequestId) + '.json'),
        encode({ operation: 'private-transcript-read', owner: 'owner', ownerRequestId, personId, botId, at, limit, before: before ?? null }))
      signal?.throwIfAborted()
      const { turns } = await snapshot(scope)
      const marker = await load(gap, 1024)
      if (marker !== undefined && (!exact(marker, ['personId', 'botId', 'incomplete'])
          || marker.personId !== personId || marker.botId !== botId || marker.incomplete !== true)) throw invalid()
      const end = Math.min(before === undefined ? turns.length : before - 1, turns.length)
      const start = Math.max(0, end - limit)
      signal?.throwIfAborted()
      return { personId, botId, turns: turns.slice(start, end).reverse(), nextBefore: start === 0 ? null : start + 1,
        incomplete: gaps.has(key) || marker !== undefined || turns.some(turn => turn.incomplete) }
    })
  }

  return { begin, finish, markIncomplete, readAudited }
}

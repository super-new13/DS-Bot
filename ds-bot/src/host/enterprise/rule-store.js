import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { link, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { validFileRule } from './file-authorization.js'

const maxBytes = 8 * 1024 * 1024
const actions = new Set(['create', 'edit', 'retire'])
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const invalid = () => Object.assign(new Error('Invalid employee rule file or update'), { code: 'invalid-rule' })
const conflict = () => Object.assign(new Error('Employee rule does not allow this change'), { code: 'rule-conflict' })
const encode = value => Buffer.from(JSON.stringify(value) + '\n')

export function parseRuleChange(input) {
  if (!exact(input, ['action', 'rule']) || !actions.has(input.action)) return undefined
  const { action, rule } = input
  if (action === 'retire') return exact(rule, ['id']) && id(rule.id) ? { action, rule: { id: rule.id } } : undefined
  if (!validFileRule(rule, { operationOnly: true }) || ![rule.id, rule.botId, rule.personId].every(id)
      || !(rule.roomId === null || id(rule.roomId))) return undefined
  return { action, rule: { ...rule } }
}

function apply(active, used, { action, rule }) {
  if (action === 'create') {
    if (used.has(rule.id) || active.size >= 1000) throw conflict()
    used.add(rule.id)
  } else if (!active.has(rule.id)) throw conflict()
  if (action === 'retire') active.delete(rule.id)
  else active.set(rule.id, Object.freeze(rule))
}

function decode(bytes) {
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!exact(raw, ['format', 'changes']) || raw.format !== 1 || !Array.isArray(raw.changes)) throw invalid()
  const active = new Map()
  const used = new Set()
  const requests = new Set()
  for (const [index, row] of raw.changes.entries()) {
    if (!exact(row, ['version', 'ownerRequestId', 'at', 'action', 'rule']) || row.version !== index + 1
        || !id(row.ownerRequestId) || requests.has(row.ownerRequestId) || !Number.isSafeInteger(row.at) || row.at < 0) throw invalid()
    const change = parseRuleChange({ action: row.action, rule: row.rule })
    if (!change) throw invalid()
    requests.add(row.ownerRequestId)
    apply(active, used, change)
  }
  return Object.freeze({ version: String(raw.changes.length), rules: Object.freeze([...active.values()]) })
}

function readFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > maxBytes) throw invalid()
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    if (length !== stat.size) throw invalid()
    return bytes.subarray(0, length)
  } finally { closeSync(fd) }
}

function validPath(path) {
  return typeof path === 'string' && isAbsolute(path) && !path.includes(String.fromCharCode(0))
}

// Each decision checks file bytes. Invalid bytes never replace the last valid
// snapshot, which is retained for version and history checks, never for grants.
export function createEmployeeRuleReader(path) {
  if (!validPath(path)) throw invalid()
  let lastBytes
  let lastValid
  return () => {
    try {
      const bytes = readFile(path)
      if (lastBytes?.equals(bytes)) return lastValid
      const snapshot = decode(bytes)
      if (lastValid) {
        const old = JSON.parse(lastBytes).changes
        const next = JSON.parse(bytes).changes
        if (next.length <= old.length || JSON.stringify(old) !== JSON.stringify(next.slice(0, old.length))) return undefined
      }
      lastBytes = bytes
      lastValid = snapshot
      return snapshot
    } catch { return undefined }
  }
}

// The employee service is the sole writer. Readers mount the parent directory
// read-only so they observe atomic filename replacement across processes.
export async function openEmployeeRuleStore(path, { initialize = false } = {}) {
  if (!validPath(path) || typeof initialize !== 'boolean') throw invalid()
  const root = await realpath(dirname(path))
  const destination = join(root, basename(path))
  let tail = Promise.resolve()
  let uncertain = false

  async function commit(bytes, first = false) {
    if (bytes.length > maxBytes) throw invalid()
    const temp = join(root, '.rule-' + randomUUID() + '.tmp')
    const file = await open(temp, 'wx', 0o600)
    let published = false
    try {
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      if (first) {
        await link(temp, destination)
        published = true
        await unlink(temp)
      } else {
        await rename(temp, destination)
        published = true
      }
      const parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY)
      try { await parent.sync() } finally { await parent.close() }
    } catch (error) {
      if (published) uncertain = true
      await unlink(temp).catch(() => {})
      throw error
    }
  }

  try { decode(readFile(destination)) }
  catch (error) {
    if (error.code !== 'ENOENT' || !initialize) throw error
    await commit(encode({ format: 1, changes: [] }), true)
  }
  const readRules = createEmployeeRuleReader(destination)
  if (!readRules()) throw invalid()

  async function change(context, input, isOwner) {
    const update = parseRuleChange(input)
    const { requestId, at } = context
    if (!update || !id(requestId) || !Number.isSafeInteger(at) || at < 0) throw invalid()
    const next = tail.then(async () => {
      if (isOwner(context) !== true || context.signal?.aborted) throw Object.assign(new Error('Owner operation refused'), { code: 'not-authorized' })
      if (uncertain || !readRules()) throw new Error('Employee rule storage unavailable')
      const raw = JSON.parse(readFile(destination))
      const row = { version: raw.changes.length + 1, ownerRequestId: requestId, at, ...update }
      raw.changes.push(row)
      const bytes = encode(raw)
      decode(bytes)
      await commit(bytes)
      return { version: String(row.version), ruleId: row.rule.id, ownerRequestId: requestId }
    })
    tail = next.catch(() => {})
    return next
  }
  return { change }
}

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync,
  realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const flags = { bigint: true }
const tempPrefix = '.dsbot-effect-'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const refused = () => fail('not-authorized', 'Business file effect refused')
const conflict = () => fail('version-conflict', 'Business file version changed')
const stamp = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino

// Use a local POSIX directory whose namespace and descendants have one worker
// writer. The operator must prevent concurrent external changes, including mount
// changes and mutations by other processes using the worker UID. Rule lookup
// requires canonical names and a case-sensitive namespace. Path checks do
// not pin ancestors, and rename does not compare a version as part of publishing.
// The synchronous entry points serialize callers in this process. Keep unmounted
// until the deployment establishes the required directory isolation.
export function createWorkerFileEffects({ root, workerOwned, authorization, maxBytes = 256 * 1024 } = {}) {
  if (workerOwned !== true || typeof root !== 'string' || !root.startsWith('/') || root === '/'
      || typeof authorization?.consume !== 'function' || !Number.isSafeInteger(maxBytes)
      || maxBytes < 1 || maxBytes > 1024 * 1024 || typeof process.getuid !== 'function'
      || typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number'
      || typeof constants.O_DIRECTORY !== 'number') throw new TypeError('Expected an explicitly worker-owned POSIX root')
  const owner = BigInt(process.getuid())
  const rootStat = lstatSync(root, flags)
  if (realpathSync(root) !== root || !rootStat.isDirectory() || rootStat.uid !== owner
      || (rootStat.mode & 0o077n) !== 0n) refused()
  let busy = false

  function serial(operation) {
    if (busy) return refused()
    busy = true
    try { return operation() } finally { busy = false }
  }

  function locate(path) {
    if (typeof path !== 'string' || !path.startsWith(root + '/') || path.length > 4096 || path.includes('\\') || path.includes('\0')) refused()
    const parts = path.slice(root.length + 1).split('/')
    if (parts.some(part => !part || part === '.' || part === '..' || part.toLowerCase().startsWith(tempPrefix))) refused()
    let parent = root
    for (const part of ['', ...parts.slice(0, -1)]) {
      if (part) parent = join(parent, part)
      const stat = lstatSync(parent, flags)
      if (!stat.isDirectory() || stat.dev !== rootStat.dev || stat.uid !== owner || (stat.mode & 0o022n) !== 0n
          || (parent === root && (!sameInode(stat, rootStat) || (stat.mode & 0o077n) !== 0n))) refused()
    }
    return { target: join(parent, parts.at(-1)), parent }
  }

  function ordinary(stat) {
    if (!stat.isFile() || stat.dev !== rootStat.dev || stat.uid !== owner || stat.nlink !== 1n || (stat.mode & 0o022n) !== 0n) refused()
    if (stat.size > BigInt(maxBytes)) fail('file-too-large', 'Business file exceeds byte limit')
  }

  function existing(target) {
    const named = lstatSync(target, { ...flags, throwIfNoEntry: false })
    if (!named) conflict()
    ordinary(named)
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = fstatSync(fd, flags)
      ordinary(before)
      if (stamp(before) !== stamp(named)) conflict()
      const buffer = Buffer.alloc(Number(before.size) + 1)
      let size = 0
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null)
        if (count === 0) break
        size += count
      }
      const after = fstatSync(fd, flags)
      ordinary(after)
      if (size !== Number(before.size) || stamp(before) !== stamp(after) || stamp(after) !== stamp(lstatSync(target, flags))) conflict()
      const bytes = buffer.subarray(0, size)
      return { bytes, version: stamp(after) + ':' + digest(bytes) }
    } finally { closeSync(fd) }
  }

  function commit({ target, parent }, action, bytes, handle) {
    const temporary = join(parent, tempPrefix + randomUUID())
    const fd = openSync(temporary, 'wx', 0o600)
    let moved = false
    let linked = false
    try {
      try {
        writeFileSync(fd, bytes)
        fsyncSync(fd)
      } finally { closeSync(fd) }
      if (authorization.consume(handle, action) !== true) refused()
      if (action.operation === 'create') {
        linkSync(temporary, target)
        linked = true
        unlinkSync(temporary)
      } else renameSync(temporary, target)
      moved = true
      const directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { fsyncSync(directory) } finally { closeSync(directory) }
      return { operation: action.operation }
    } catch (error) {
      if (moved || linked) fail('file-effect-unknown', 'Business file effect outcome is uncertain')
      if (error.code === 'EEXIST') conflict()
      throw error
    } finally {
      if (!moved) {
        try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    }
  }

  function execute(handle, input, content) {
    return serial(() => {
      const action = Object.freeze({ ...input })
      const { operation } = action
      if (!['read', 'create', 'modify'].includes(operation)) refused()
      const location = locate(action.path)
      const { target } = location
      if (operation === 'read') {
        if (content !== undefined || action.contentDigest !== null) refused()
        const result = existing(target)
        if (result.version !== action.version) conflict()
        if (authorization.consume(handle, action) !== true) refused()
        return result
      }
      if (!Buffer.isBuffer(content)) refused()
      if (content.length > maxBytes) fail('file-too-large', 'Business file exceeds byte limit')
      const bytes = Buffer.from(content)
      if (digest(bytes) !== action.contentDigest) refused()
      if (operation === 'create') {
        if (action.version !== null) refused()
        const named = lstatSync(target, { ...flags, throwIfNoEntry: false })
        if (named) { ordinary(named); conflict() }
      } else if (existing(target).version !== action.version) conflict()
      return commit(location, action, bytes, handle)
    })
  }

  // Trusted approval preparation uses only the version, without releasing bytes.
  return { inspectVersion: path => serial(() => existing(locate(path).target).version), execute }
}

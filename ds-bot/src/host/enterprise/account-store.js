import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const hash = /^[0-9a-f]{64}$/
const passwordHash = /^scrypt-v1:[0-9a-f]{32}:[0-9a-f]{64}$/
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value)
const id = value => typeof value === 'string' && value.trim() !== ''
const time = value => Number.isSafeInteger(value) && value >= 0
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fields = (value, ...keys) => record(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key))
const invalid = () => new Error('Invalid employee account store')

function decode(text) {
  let state
  try {
    state = JSON.parse(text)
  } catch {
    throw invalid()
  }
  if (!fields(state, 'accounts', 'sessions') || !record(state.accounts) || !Array.isArray(state.sessions)) throw invalid()

  const inviteHashes = new Set()
  for (const [personId, account] of Object.entries(state.accounts)) {
    const hasInvite = record(account) && Object.hasOwn(account, 'invite')
    if (!id(personId) || !(hasInvite ? fields(account, 'passwordHash', 'revokedAt', 'invite') : fields(account, 'passwordHash', 'revokedAt'))) throw invalid()
    if (account.passwordHash !== null && !matches(passwordHash, account.passwordHash)) throw invalid()
    if (account.revokedAt !== null && (!time(account.revokedAt) || hasInvite || account.passwordHash !== null)) throw invalid()
    if (hasInvite) {
      const { invite } = account
      if (!fields(invite, 'hash', 'expiresAt') || !matches(hash, invite.hash) || !time(invite.expiresAt) || inviteHashes.has(invite.hash)) throw invalid()
      inviteHashes.add(invite.hash)
    }
  }

  const sessionIds = new Set()
  const sessionHashes = new Set()
  for (const session of state.sessions) {
    if (!fields(session, 'id', 'personId', 'hash', 'expiresAt') || !id(session.id) || !id(session.personId)
      || !matches(hash, session.hash) || !time(session.expiresAt) || sessionIds.has(session.id) || sessionHashes.has(session.hash)) throw invalid()
    const account = Object.hasOwn(state.accounts, session.personId) ? state.accounts[session.personId] : undefined
    if (!account || account.revokedAt !== null || account.passwordHash === null) throw invalid()
    sessionIds.add(session.id)
    sessionHashes.add(session.hash)
  }
  return state
}

// Use one instance per file in a single service process, in a pre-existing private directory.
// Pass initialize only for first-time provisioning. On restart a missing file fails closed.
export async function openEmployeeAccountStore(file, { initialize = false } = {}) {
  const path = resolve(file)
  const parent = dirname(path)
  let tail = Promise.resolve()
  let uncertain = false

  const load = async () => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!(await handle.stat()).isFile()) throw invalid()
      return decode(await handle.readFile('utf8'))
    } finally {
      await handle.close()
    }
  }

  const commit = async text => {
    const temporary = join(parent, '.employee-accounts-' + randomUUID() + '.tmp')
    const handle = await open(temporary, 'wx', 0o600)
    let renamed = false
    try {
      try {
        await handle.writeFile(text, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, path)
      renamed = true
      // Directory fsync makes the rename durable on the enterprise Linux host.
      if (process.platform !== 'win32') {
        const directory = await open(parent, 'r')
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
      }
    } catch (error) {
      // A failed sync after rename leaves an uncertain commit. Stop serving this instance.
      if (renamed) uncertain = true
      throw error
    } finally {
      if (!renamed) await unlink(temporary).catch(() => {})
    }
  }

  try {
    await load()
  } catch (error) {
    if (error.code !== 'ENOENT' || !initialize) throw error
    await commit('{"accounts":{},"sessions":[]}\n')
  }

  const enqueue = operation => {
    const result = tail.then(() => {
      if (uncertain) throw new Error('Employee account store commit outcome is uncertain')
      return operation()
    })
    tail = result.catch(() => {})
    return result
  }

  const read = () => enqueue(load)
  const transact = change => enqueue(async () => {
    const draft = await load()
    const result = change(draft)
    if (typeof result?.then === 'function') {
      void Promise.resolve(result).catch(() => {})
      throw new TypeError('Employee account transactions require a synchronous callback')
    }
    const text = JSON.stringify(draft)
    decode(text)
    await commit(text + '\n')
    return result
  })

  return { read, transact }
}

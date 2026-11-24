import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const derive = promisify(scrypt)
const inviteLifetime = 60 * 60 * 1000
const sessionLifetime = 7 * 24 * 60 * 60 * 1000
const token = () => randomBytes(32).toString('base64url')
const digest = (purpose, value) => createHash('sha256').update(purpose).update(':').update(value).digest('hex')
const validToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
const validId = value => typeof value === 'string' && value.trim() !== ''
const validPassword = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1024
const key = (password, salt) => derive(password, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 160 * 1024 * 1024 })
const passwordRecord = /^scrypt-v1:([0-9a-f]{32}):([0-9a-f]{64})$/

async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = await key(password, salt)
  return ['scrypt-v1', salt, hash.toString('hex')].join(':')
}

async function matchesPassword(password, record) {
  const parsed = typeof record === 'string' ? passwordRecord.exec(record) : null
  const actual = await key(password, parsed?.[1] ?? '0'.repeat(32))
  const expected = Buffer.from(parsed?.[2] ?? '0'.repeat(64), 'hex')
  return timingSafeEqual(actual, expected) && parsed !== null
}

function accountOf(state, personId) {
  if (!validId(personId) || !Object.hasOwn(state.accounts, personId)) return undefined
  return state.accounts[personId]
}

const active = account => account?.revokedAt === null
const live = (record, now) => Number.isSafeInteger(record?.expiresAt) && record.expiresAt > now
const hasPassword = account => typeof account?.passwordHash === 'string' && passwordRecord.test(account.passwordHash)

function sessionIdentity(state, session, now) {
  if (!validId(session.id) || !live(session, now)) return undefined
  const account = accountOf(state, session.personId)
  if (!active(account) || !hasPassword(account)) return undefined
  return { personId: session.personId, loginSessionId: session.id }
}

function findInvitation(state, inviteHash, now) {
  const matches = Object.entries(state.accounts).filter(([, account]) =>
    active(account) && live(account.invite, now) && account.invite.hash === inviteHash)
  return matches.length === 1 ? matches[0] : undefined
}

// The backing store starts with { accounts: {}, sessions: [] }. read() returns a fresh
// snapshot. transact(change) serializes across writers and atomically commits the mutable
// draft before returning the synchronous callback's result. Neither method may serve stale state.
export function createEmployeeAccounts({ read, transact, now = Date.now }) {
  // Only trusted management callers issue invites or revoke accounts/sessions.
  const issueInvite = (personId, { reset = false } = {}) => {
    if (!validId(personId) || typeof reset !== 'boolean') return undefined
    return transact(state => {
      const existing = accountOf(state, personId)
      if (existing !== undefined && (!active(existing) || reset !== (existing.passwordHash !== null))) return undefined
      if (existing === undefined && reset) return undefined
      const invitation = token()
      const expiresAt = now() + inviteLifetime
      const account = existing ?? { passwordHash: null, revokedAt: null }
      account.invite = { hash: digest('employee-invite', invitation), expiresAt }
      Object.defineProperty(state.accounts, personId, { value: account, enumerable: true, writable: true, configurable: true })
      return { token: invitation, expiresAt }
    })
  }

  const redeemInvite = async (invitation, password) => {
    if (!validToken(invitation) || !validPassword(password)) return undefined
    const inviteHash = digest('employee-invite', invitation)
    if (!findInvitation(await read(), inviteHash, now())) return undefined
    const passwordHash = await hashPassword(password)
    return transact(state => {
      const entry = findInvitation(state, inviteHash, now())
      if (!entry) return undefined
      const [personId, account] = entry
      account.passwordHash = passwordHash
      delete account.invite
      state.sessions = state.sessions.filter(session => session.personId !== personId)
      return { personId }
    })
  }

  const login = async (personId, password) => {
    if (!validId(personId) || !validPassword(password)) return undefined
    const account = accountOf(await read(), personId)
    const passwordHash = active(account) ? account.passwordHash : undefined
    if (!await matchesPassword(password, passwordHash)) return undefined
    return transact(state => {
      // Password hashing runs outside the transaction. Recheck current credentials before issuing.
      const current = accountOf(state, personId)
      if (!active(current) || current.passwordHash !== passwordHash) return undefined
      const sessionToken = token()
      const id = randomUUID()
      const time = now()
      const expiresAt = time + sessionLifetime
      state.sessions = state.sessions.filter(session => live(session, time))
      state.sessions.push({ id, personId, hash: digest('employee-session', sessionToken), expiresAt })
      return { id, token: sessionToken, expiresAt }
    })
  }

  const resolveSession = async sessionToken => {
    if (!validToken(sessionToken)) return undefined
    const hash = digest('employee-session', sessionToken)
    const state = await read()
    const matches = state.sessions.filter(session => session.hash === hash)
    if (matches.length !== 1) return undefined
    return sessionIdentity(state, matches[0], now())
  }

  // Recheck trusted context before deferred work without retaining the bearer token.
  const isSessionActive = async context => {
    const { personId, loginSessionId } = context ?? {}
    if (!validId(personId) || !validId(loginSessionId)) return false
    const state = await read()
    const matches = state.sessions.filter(session => session.id === loginSessionId)
    return matches.length === 1 && matches[0].personId === personId
      && sessionIdentity(state, matches[0], now()) !== undefined
  }

  const revokeSession = (personId, id) => transact(state => {
    if (!validId(personId) || !validId(id)) return false
    const count = state.sessions.length
    state.sessions = state.sessions.filter(session => session.personId !== personId || session.id !== id)
    return count !== state.sessions.length
  })

  const revokeAccount = personId => transact(state => {
    const account = accountOf(state, personId)
    if (!active(account)) return false
    account.revokedAt = now()
    account.passwordHash = null
    delete account.invite
    state.sessions = state.sessions.filter(session => session.personId !== personId)
    return true
  })

  return { issueInvite, redeemInvite, login, resolveSession, isSessionActive, revokeSession, revokeAccount }
}

import { createHash, timingSafeEqual } from 'node:crypto'

const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/i
const digest = /^[a-f0-9]{64}$/

// The caller supplies raw singular header values and the direct TLS peer address.
// The credential is 32 random bytes encoded as unpadded base64url. Store its
// SHA-256 digest (over the encoded string) in the operator configuration.
export function createOwnerAdmission({ origin, tokenHash, now = Date.now,
  windowMs = 60_000, globalLimit = 60, clientLimit = 8, maxClients = 256 } = {}) {
  if (typeof tokenHash !== 'string' || !digest.test(tokenHash) || URL.parse(origin)?.origin !== origin
      || typeof origin !== 'string' || !origin.startsWith('https://') || typeof now !== 'function'
      || ![windowMs, globalLimit, clientLimit, maxClients].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new TypeError('Invalid enterprise owner admission configuration')
  }
  const expected = Buffer.from(tokenHash, 'hex')
  const owner = Object.freeze({ role: 'owner' })
  const clients = new Map()
  let until = 0
  let total = 0

  return {
    isOwner: context => context === owner,
    admit({ authorization, requestOrigin, fetchSite, clientKey } = {}) {
      if (requestOrigin !== origin || fetchSite === 'cross-site') return { status: 403 }
      if (typeof clientKey !== 'string' || !clientKey) return { status: 401 }
      const time = now()
      if (time >= until) {
        until = time + windowMs
        total = 0
        clients.clear()
      }
      const count = clients.get(clientKey) ?? 0
      if (total >= globalLimit || count >= clientLimit || (!clients.has(clientKey) && clients.size >= maxClients)) {
        return { status: 429, retryAfter: Math.max(1, Math.ceil((until - time) / 1000)) }
      }
      clients.set(clientKey, count + 1)
      total++

      const token = typeof authorization === 'string' ? bearer.exec(authorization)?.[1] : undefined
      if (!token || Buffer.from(token, 'base64url').toString('base64url') !== token) return { status: 401 }
      const received = createHash('sha256').update(token).digest()
      if (!timingSafeEqual(received, expected)) return { status: 401 }
      return { context: owner }
    },
  }
}

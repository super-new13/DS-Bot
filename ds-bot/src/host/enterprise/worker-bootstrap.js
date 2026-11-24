import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { apply as applyWorker } from './worker-plugin.js'

const actions = new Set(['create', 'submit', 'cancel', 'status'])
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const absolute = path => typeof path === 'string' && isAbsolute(path)
const invalid = () => new TypeError('Invalid administrator worker bootstrap configuration')
const maxPemBytes = 128 * 1024

async function loadPem(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > maxPemBytes) throw invalid()
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length !== stat.size) throw invalid()
    return bytes.subarray(0, length)
  } finally { await file.close() }
}

// The trusted DSH entry passes its administrator settings and model adapter
// directly. This snapshots grants for the lifetime of the activated plugin.
export function createWorkerBootstrap({ config, adapter, onReady } = {}) {
  const { nodeId, provider, model, receiptPath, initialize = false, host, port, origin, certPaths, peerGrants } = config ?? {}
  if (!id(nodeId) || typeof provider !== 'string' || !provider.trim() || typeof model !== 'string' || !model.trim()
      || !absolute(receiptPath) || typeof initialize !== 'boolean' || !Array.isArray(peerGrants) || !peerGrants.length
      || typeof adapter?.stream !== 'function' || typeof adapter.resolveModel !== 'function'
      || (onReady !== undefined && typeof onReady !== 'function')) throw invalid()
  const { ca: caPath, cert: certPath, key: keyPath } = certPaths ?? {}
  if (![caPath, certPath, keyPath].every(absolute)) throw invalid()
  const grants = peerGrants.map(grant => {
    const { fingerprint, personId, botId, actions: allowed } = grant ?? {}
    if (typeof fingerprint !== 'string' || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint)
        || !id(personId) || !id(botId) || !Array.isArray(allowed) || !allowed.length
        || allowed.some(action => !actions.has(action))) throw invalid()
    return { fingerprint, personId, botId, actions: new Set(allowed) }
  })
  const matches = (grant, scope) => scope.nodeId === nodeId && grant.personId === scope.personId && grant.botId === scope.botId
  return {
    name: 'enterprise-worker-bootstrap',
    async apply(profile) {
      const [ca, cert, key] = await Promise.all([loadPem(caPath), loadPem(certPath), loadPem(keyPath)])
      return applyWorker(profile, {
        nodeId, provider, model, receiptPath, initialize, host, port, origin, adapter, onReady, tls: { ca, cert, key },
        authorizePeer: (fingerprint, { scope, action }) => grants.some(grant => grant.fingerprint === fingerprint
          && matches(grant, scope) && grant.actions.has(action)),
        authorizeSession: scope => grants.some(grant => matches(grant, scope)),
      })
    },
  }
}

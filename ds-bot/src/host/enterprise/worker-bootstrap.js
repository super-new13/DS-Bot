import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { apply as applyWorker } from './worker-plugin.js'
import { snapshotFileOperations } from './worker-file-tools.js'

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

// File callbacks are accepted only as a programmatic dependency of the trusted entry.
function snapshotFileTools(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid()
  const { root, path, workerOwned, readRules, isAuthorized, adjudicate, writeAudit, maxBytes = 256 * 1024 } = options
  const canonical = value => absolute(value) && !value.includes(String.fromCharCode(0)) && resolve(value) === value
  if (workerOwned !== true || !canonical(root) || root === sep || !canonical(path) || !path.startsWith(root + sep)
      || ![readRules, isAuthorized, adjudicate].every(callback => typeof callback === 'function')
      || (writeAudit !== undefined && typeof writeAudit !== 'function')
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw invalid()
  return Object.freeze({ root, path, workerOwned, readRules, isAuthorized, adjudicate, writeAudit, maxBytes, operations: snapshotFileOperations(options.operations) })
}

// The trusted DSH entry passes its administrator settings and model adapter
// directly. This snapshots grants for the lifetime of the activated plugin.
export function createWorkerBootstrap({ config, adapter, onReady, fileTools } = {}) {
  if (Object.hasOwn(config ?? {}, 'fileTools')) throw invalid()
  const trustedFileTools = fileTools === undefined ? undefined : snapshotFileTools(fileTools)
  const { nodeId, provider, model, receiptPath, mappingPath, sessionRoot, initialize = false, host, port, origin, certPaths, peerGrants } = config ?? {}
  if (!id(nodeId) || typeof provider !== 'string' || !provider.trim() || typeof model !== 'string' || !model.trim()
      || !absolute(receiptPath) || typeof initialize !== 'boolean' || !Array.isArray(peerGrants) || !peerGrants.length
      || typeof adapter?.stream !== 'function' || typeof adapter.resolveModel !== 'function'
      || (onReady !== undefined && typeof onReady !== 'function')) throw invalid()
  if ((mappingPath !== undefined || sessionRoot !== undefined) && (!absolute(mappingPath) || !absolute(sessionRoot))) throw invalid()
  const { ca: caPath, cert: certPath, key: keyPath } = certPaths ?? {}
  if (![caPath, certPath, keyPath].every(absolute)) throw invalid()
  const grants = peerGrants.map(grant => {
    const { fingerprint, personId, botId, roomId, actions: allowed } = grant ?? {}
    if (typeof fingerprint !== 'string' || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint)
        || !id(personId) || !id(botId) || (Object.hasOwn(grant ?? {}, 'roomId') && !id(roomId))
        || !Array.isArray(allowed) || !allowed.length
        || allowed.some(action => !actions.has(action))) throw invalid()
    return { fingerprint, personId, botId, roomId, actions: new Set(allowed) }
  })
  const allowRooms = grants.some(grant => grant.roomId !== undefined)
  if (allowRooms && (!absolute(mappingPath) || !absolute(sessionRoot))) throw invalid()
  const matches = (grant, scope) => scope.nodeId === nodeId && grant.personId === scope.personId
    && grant.botId === scope.botId && grant.roomId === scope.roomId
  return {
    name: 'enterprise-worker-bootstrap',
    async apply(profile) {
      const [ca, cert, key] = await Promise.all([loadPem(caPath), loadPem(certPath), loadPem(keyPath)])
      return applyWorker(profile, {
        nodeId, provider, model, receiptPath, mappingPath, sessionRoot, initialize, host, port, origin, adapter, onReady, tls: { ca, cert, key },
        allowRooms, fileTools: trustedFileTools,
        authorizePeer: (fingerprint, { scope, action }) => grants.some(grant => grant.fingerprint === fingerprint
          && matches(grant, scope) && grant.actions.has(action)),
        authorizeSession: scope => grants.some(grant => matches(grant, scope)),
      })
    },
  }
}

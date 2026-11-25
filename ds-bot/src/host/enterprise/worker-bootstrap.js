import { createEmployeeRuleReader } from './rule-store.js'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { openFileAuditStore } from './file-audit-store.js'
import { openFileEffectOutbox } from './file-effect-outbox.js'
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
function snapshotFileTools(options, nodeId, ruleFile) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw invalid()
  const { root, path, workerOwned, readRules: legacyRules, isAuthorized, adjudicate, writeAudit, permit, onCompleted, maxBytes = 256 * 1024 } = options
  const readRules = ruleFile === undefined ? legacyRules : createEmployeeRuleReader(ruleFile)
  const canonical = value => absolute(value) && !value.includes(String.fromCharCode(0)) && resolve(value) === value
  if (workerOwned !== true || !canonical(root) || root === sep || !canonical(path) || !path.startsWith(root + sep)
      || ![readRules, isAuthorized, adjudicate].every(callback => typeof callback === 'function')
      || (writeAudit !== undefined && typeof writeAudit !== 'function')
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw invalid()
  let trustedPermit
  if (permit !== undefined) {
    const { nodeId: permitNode, path: permitPath, targetId, client } = permit ?? {}
    if (permitNode !== nodeId || permitPath !== path || typeof targetId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(targetId)
        || typeof client?.reserve !== 'function') throw invalid()
    trustedPermit = Object.freeze({ nodeId, path, targetId, client: Object.freeze({ reserve: client.reserve.bind(client) }) })
  }
  if (onCompleted !== undefined && (!trustedPermit || typeof onCompleted !== 'function')) throw invalid()
  return Object.freeze({ root, path, workerOwned, readRules, isAuthorized, adjudicate, writeAudit, permit: trustedPermit, onCompleted,
    maxBytes, operations: snapshotFileOperations(options.operations),
  })
}

// The trusted DSH entry passes its administrator settings and model adapter
// directly. This snapshots grants for the lifetime of the activated plugin.
export function createWorkerBootstrap({ config, adapter, onReady, fileTools, ingestEvidence, ruleFile } = {}) {
  if (Object.hasOwn(config ?? {}, 'fileTools')) throw invalid()
  const { nodeId, provider, model, receiptPath, mappingPath, sessionRoot, auditFile, outboxFile, initialize = false, host, port, origin, certPaths, peerGrants } = config ?? {}
  const trustedFileTools = fileTools === undefined ? undefined : snapshotFileTools(fileTools, nodeId, ruleFile)
  if (ruleFile !== undefined && (!trustedFileTools || !absolute(ruleFile) || resolve(ruleFile) !== ruleFile
      || [receiptPath, mappingPath, auditFile, outboxFile, trustedFileTools.path, ...Object.values(certPaths ?? {})]
        .some(path => absolute(path) && resolve(path) === ruleFile))) throw invalid()
  if (auditFile !== undefined && (!absolute(auditFile) || auditFile.includes(String.fromCharCode(0))
      || !trustedFileTools || trustedFileTools.writeAudit !== undefined)) throw invalid()
  if (outboxFile === undefined ? ingestEvidence !== undefined
    : !absolute(outboxFile) || outboxFile.includes(String.fromCharCode(0)) || !trustedFileTools?.permit
      || trustedFileTools.onCompleted !== undefined || typeof ingestEvidence !== 'function' || typeof onReady !== 'function') throw invalid()
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
      const options = {
        nodeId, provider, model, receiptPath, mappingPath, sessionRoot, initialize, host, port, origin, adapter, onReady, tls: { ca, cert, key },
        allowRooms, fileTools: trustedFileTools,
        authorizePeer: (fingerprint, { scope, action }) => grants.some(grant => grant.fingerprint === fingerprint
          && matches(grant, scope) && grant.actions.has(action)),
        authorizeSession: scope => grants.some(grant => matches(grant, scope)),
      }
      if (auditFile === undefined && outboxFile === undefined) return applyWorker(profile, options)

      const canonicalFile = async file => join(await realpath(dirname(file)), basename(file))
      const auditPath = auditFile === undefined ? undefined : await canonicalFile(auditFile)
      const outboxPath = outboxFile === undefined ? undefined : await canonicalFile(outboxFile)
      const protectedPaths = [receiptPath, mappingPath, trustedFileTools.path, caPath, certPath, keyPath].filter(path => path !== undefined)
      const others = await Promise.all(protectedPaths.map(async path => realpath(path).catch(error => {
        if (error.code !== 'ENOENT') throw error
        return canonicalFile(path)
      })))
      // Refuse case and Unicode aliases before creating either store.
      const pathKey = path => path.normalize('NFC').toLowerCase()
      const used = new Set(others.map(pathKey))
      for (const path of [auditPath, outboxPath]) {
        if (path === undefined) continue
        if (used.has(pathKey(path))) throw invalid()
        used.add(pathKey(path))
      }
      if (outboxPath && sessionRoot) {
        const sessions = await realpath(sessionRoot).catch(error => {
          if (error.code !== 'ENOENT') throw error
          return canonicalFile(sessionRoot)
        })
        if (pathKey(outboxPath) === pathKey(sessions) || pathKey(outboxPath).startsWith(pathKey(sessions) + sep)) throw invalid()
      }

      let audit
      let outbox
      const closeStores = () => Promise.all([audit?.close(), outbox?.close()])
      try {
        if (auditPath) audit = await openFileAuditStore(auditPath, { initialize })
        if (outboxPath) outbox = await openFileEffectOutbox(outboxPath, { initialize })
        const stopWorker = await applyWorker(profile, {
          ...options,
          fileTools: { ...trustedFileTools, ...(audit && { writeAudit: audit.writeAudit }), ...(outbox && { onCompleted: outbox.onCompleted }) },
          onReady: outbox ? ready => onReady(Object.freeze({ ...ready, drainEvidence: limits => outbox.drain(ingestEvidence, limits) })) : onReady,
        })
        let closing
        return () => closing ??= (async () => {
          try { await stopWorker() } finally { await closeStores() }
        })()
      } catch (error) {
        await closeStores()
        throw error
      }
    },
  }
}

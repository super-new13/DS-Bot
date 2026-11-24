import { createHash } from 'node:crypto'
import { createFileAdjudicator } from './file-adjudicator.js'
import { createBusinessFileAuthorization } from './file-authorization.js'
import { createFilePermitGate } from './file-permit-effect.js'
import { createWorkerFileEffects } from './file-effects.js'

const fields = new Set(['operation', 'path', 'version', 'content'])
const refused = () => Object.assign(new Error('Business file operation refused'), { code: 'not-authorized' })
const auditUnavailable = () => Object.assign(new Error('File authorization audit unavailable'), { code: 'file-audit-unavailable' })

export function createWorkerFileDispatch({ root, workerOwned, readRules, isAuthorized, adjudicate,
  maxBytes = 256 * 1024, timeoutMs, ttlMs, maxPending, now, writeAudit, permit } = {}) {
  if (writeAudit !== undefined && typeof writeAudit !== 'function') throw new TypeError('Invalid file audit writer')
  const confirmPermit = permit === undefined ? undefined : createFilePermitGate(permit)
  const authorization = createBusinessFileAuthorization({ readRules, isAuthorized, ttlMs, maxPending, now })
  const approve = createFileAdjudicator({ authorization, adjudicate, timeoutMs })
  const effects = createWorkerFileEffects({ root, workerOwned, authorization, maxBytes })

  // The caller supplies scope from the live dispatch and the expected version
  // from trusted preparation. Tool arguments cannot override the actor or digest.
  return async function dispatch(scope, input, { context, signal } = {}) {
    if (!scope || !input || Object.keys(input).some(field => !fields.has(field))) throw refused()
    const { personId, botId, roomId, sessionId, requestId, dispatchId } = scope
    const { operation, path, version, content } = input
    if (!['create', 'modify', 'read'].includes(operation) || typeof path !== 'string' || !path.startsWith(root + '/')) throw refused()
    const writes = operation !== 'read'
    if (writes ? !Buffer.isBuffer(content) || content.length > maxBytes : content !== undefined) throw refused()
    const bytes = writes ? Buffer.from(content) : undefined
    const action = Object.freeze({ personId, botId, roomId, sessionId, requestId, dispatchId, operation, path, version,
      contentDigest: bytes ? createHash('sha256').update(bytes).digest('hex') : null })
    const identity = { personId, botId, roomId, sessionId, requestId, dispatchId, operation }
    let decision
    const approval = await approve(action, { context, onDecision: writeAudit && (async record => {
      decision = record
      try {
        if (await writeAudit(Object.freeze({ type: 'file-authorization', ...identity, ...record })) === false) throw auditUnavailable()
      } catch { throw auditUnavailable() }
    }) })
    if (!approval) throw refused()
    if (confirmPermit) await confirmPermit(action, approval, { signal })
    if (!writeAudit) return effects.execute(approval, action, bytes)

    const report = async outcome => {
      try {
        return await writeAudit(Object.freeze({ type: 'file-effect', ...identity, ...decision, outcome })) !== false
      } catch { return false }
    }
    let result
    try {
      result = effects.execute(approval, action, bytes)
    } catch (error) {
      await report(error?.code === 'file-effect-unknown' ? 'unknown' : 'failed')
      throw error
    }
    return await report('completed') ? result : { ...result, auditIncomplete: true }
  }
}

import { performance } from 'node:perf_hooks'

const verdictFields = ['verdict', 'ruleId', 'ruleVersion', 'reason']

function isAllow(output, decision) {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return false
  const fields = Object.getOwnPropertyDescriptors(output)
  if (Reflect.ownKeys(fields).length !== verdictFields.length
      || !verdictFields.every(key => Object.hasOwn(fields, key) && Object.hasOwn(fields[key], 'value'))) return false
  const reason = fields.reason.value
  return fields.verdict.value === 'allow' && fields.ruleId.value === decision.ruleId
    && fields.ruleVersion.value === decision.ruleVersion && typeof reason === 'string'
    && reason.length <= 512 && reason.trim() !== ''
}

// The injected adjudicator returns decoded data. Any context comes from the
// host and must be limited to what the matched purpose condition needs.
export function createFileAdjudicator({ authorization, adjudicate, timeoutMs = 5000 } = {}) {
  if (typeof authorization?.prepare !== 'function' || typeof authorization.decide !== 'function'
      || typeof adjudicate !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError('Invalid file adjudicator settings')
  }

  return async function approve(input, { context } = {}) {
    if (context !== undefined && (typeof context !== 'string' || context.length > 2048)) return undefined
    const action = Object.freeze({ ...input })
    const decision = authorization.prepare(action)
    if (!decision) return undefined
    const question = Object.freeze({
      rule: Object.freeze({ id: decision.ruleId, version: decision.ruleVersion, purpose: decision.purpose }),
      action: Object.freeze({ operation: action.operation, path: action.path }),
      ...(context === undefined ? {} : { context }),
    })
    const controller = new AbortController()
    const deadline = performance.now() + timeoutMs
    let timer
    let allowed = false
    try {
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
          resolve(undefined)
          controller.abort()
        }, timeoutMs)
      })
      const output = await Promise.race([timeout, Promise.resolve().then(() => adjudicate(question, { signal: controller.signal }))])
      allowed = isAllow(output, decision) && performance.now() < deadline && !controller.signal.aborted
    } catch {
      // Transport failures and undecodable verdicts close the decision.
    } finally {
      clearTimeout(timer)
    }
    return authorization.decide(decision, allowed ? 'allow' : 'deny') ? decision : undefined
  }
}

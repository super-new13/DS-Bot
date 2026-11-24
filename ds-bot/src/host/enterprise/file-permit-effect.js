import { isAbsolute, resolve } from 'node:path'

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
const refused = () => Object.assign(new Error('File reservation refused'), { code: 'not-authorized' })

// The caller supplies an authenticated reservation client and binds its target
// ID to one local path. The permit reply is tied to that exact request by the client.
export function createFilePermitGate({ client, nodeId, targetId, path } = {}) {
  if (typeof client?.reserve !== 'function' || !id(nodeId) || !id(targetId)
      || typeof path !== 'string' || !isAbsolute(path) || path.includes(String.fromCharCode(0)) || resolve(path) !== path) {
    throw new TypeError('Invalid file permit gate configuration')
  }
  const reserve = client.reserve.bind(client)
  return async (action, approval, { signal } = {}) => {
    if (action.path !== path || signal?.aborted) throw refused()
    const { personId, botId, roomId, sessionId, requestId, dispatchId, operation, version, contentDigest } = action
    const scope = Object.freeze({ nodeId, targetId, personId, botId, roomId, sessionId, requestId, dispatchId,
      operation, version, contentDigest, ruleId: approval.ruleId, ruleVersion: approval.ruleVersion,
    })
    const result = await reserve(scope, { signal })
    if (signal?.aborted || !result || typeof result !== 'object' || Array.isArray(result)
        || Object.keys(result).length !== 2 || !Object.hasOwn(result, 'issued') || !Object.hasOwn(result, 'status')
        || result.issued !== true || result.status !== 'reserved') throw refused()
    return scope
  }
}

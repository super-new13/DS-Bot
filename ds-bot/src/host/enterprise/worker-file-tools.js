import { AsyncLocalStorage } from 'node:async_hooks'
import { createWorkerFileDispatch } from './file-dispatch.js'
import { createWorkerFileEffects } from './file-effects.js'

const tools = new Map([
  ['worker_replace_file', { operation: 'modify', description: 'Replace the text in the worker’s configured business file' }],
  ['worker_read_file', { operation: 'read', description: 'Read UTF-8 text from the worker’s configured business file' }],
  ['worker_create_file', { operation: 'create', description: 'Create the worker’s configured business file with the supplied text' }],
])
const knownOperations = new Set(Array.from(tools.values(), tool => tool.operation))
const refused = () => Object.assign(new Error('Worker file operation refused'), { code: 'not-authorized' })

export function snapshotFileOperations(operations = ['modify']) {
  if (!Array.isArray(operations) || !operations.length || new Set(operations).size !== operations.length
      || !Array.from(operations).every(operation => knownOperations.has(operation))) {
    throw new TypeError('Invalid worker file tool operations')
  }
  return Object.freeze([...operations])
}

function toolInput(args, operation) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const count = Object.keys(args).length
  if (operation === 'read') return count === 0 ? null : undefined
  return count === 1 && Object.hasOwn(args, 'content') && typeof args.content === 'string' ? args.content : undefined
}

// The host selects a single target and the allowed operations.
export function installWorkerFileTools(ctx, currentTurn, config) {
  const { root, path, workerOwned, readRules, isAuthorized, adjudicate, writeAudit, maxBytes = 256 * 1024, operations } = config ?? {}
  if (typeof root !== 'string' || typeof path !== 'string' || !path.startsWith(root + '/')
      || typeof isAuthorized !== 'function') throw new TypeError('Invalid worker file tool configuration')
  const enabled = new Set(snapshotFileOperations(operations))
  const { inspectVersion } = createWorkerFileEffects({ root, workerOwned, maxBytes, authorization: { consume: () => false } })
  const dispatches = new AsyncLocalStorage()
  const isLive = binding => binding?.open === true && !binding.signal.aborted && binding.turn.isCurrent()
  const dispatch = createWorkerFileDispatch({ root, workerOwned, readRules, adjudicate, maxBytes, writeAudit,
    isAuthorized(action) {
      const current = dispatches.getStore()
      return isLive(current) && action.dispatchId === current.callId && action.operation === current.operation
        && ['personId', 'botId', 'roomId', 'sessionId', 'requestId'].every(key => current.turn[key] === action[key])
        && isAuthorized(action) === true
    },
  })

  ctx.on('tools/execute', async (exec, next) => {
    const operation = tools.get(exec.name)?.operation
    if (!enabled.has(operation) || exec.parent !== undefined || !exec.callId || exec.rootCallId !== exec.callId
        || typeof exec.token !== 'symbol' || exec.signal.aborted || dispatches.getStore()) throw refused()
    const content = toolInput(exec.arguments, operation)
    if (content === undefined || (content !== null && Buffer.byteLength(content) > maxBytes)) throw refused()
    const turn = currentTurn(exec.agent)
    if (!turn) throw refused()
    const binding = { operation, turn, callId: exec.callId, token: exec.token, signal: exec.signal, content, open: true, used: false }
    try { return await dispatches.run(binding, next) } finally { binding.open = false }
  }, { prepend: true })

  for (const [name, { operation, description }] of tools) {
    if (!enabled.has(operation)) continue
    ctx.tools.register({
      name, description,
      parameters: operation === 'read' ? { type: 'object', properties: {}, additionalProperties: false }
        : { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
      async execute(args, exec) {
        const binding = dispatches.getStore()
        if (!isLive(binding) || binding.used || exec.token !== binding.token || exec.callId !== binding.callId
            || exec.rootCallId !== binding.callId || exec.parent !== undefined || binding.operation !== operation
            || toolInput(args, operation) !== binding.content) throw refused()
        binding.used = true
        const { personId, botId, roomId, sessionId, requestId } = binding.turn
        try {
          const result = await dispatch({ personId, botId, roomId, sessionId, requestId, dispatchId: binding.callId }, {
            operation, path, version: operation === 'create' ? null : inspectVersion(path),
            ...(operation !== 'read' && { content: Buffer.from(binding.content) }),
          })
          if (operation === 'read') {
            if (!isLive(binding) || !Buffer.isBuffer(result.bytes) || result.bytes.length > maxBytes) throw refused()
            return new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)
          }
          const summary = operation === 'create' ? 'File created' : 'File updated'
          return result.auditIncomplete ? summary + ' (audit incomplete)' : summary
        } catch (error) {
          if (error?.code === 'file-effect-unknown') throw new Error('Worker file outcome unknown')
          throw refused()
        }
      },
    })
  }
}

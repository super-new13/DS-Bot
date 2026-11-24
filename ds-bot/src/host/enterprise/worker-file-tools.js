import { AsyncLocalStorage } from 'node:async_hooks'
import { createWorkerFileDispatch } from './file-dispatch.js'
import { createWorkerFileEffects } from './file-effects.js'

const name = 'worker_replace_file'
const refused = () => Object.assign(new Error('Worker file operation refused'), { code: 'not-authorized' })
const contentOf = args => args && Object.keys(args).length === 1 && Object.hasOwn(args, 'content')
  && typeof args.content === 'string' ? args.content : undefined

// The host selects a single existing target. The model supplies replacement text.
export function installWorkerFileTools(ctx, currentTurn, config) {
  const { root, path, workerOwned, readRules, isAuthorized, adjudicate, maxBytes = 256 * 1024 } = config ?? {}
  if (typeof root !== 'string' || typeof path !== 'string' || !path.startsWith(root + '/')
      || typeof isAuthorized !== 'function') throw new TypeError('Invalid worker file tool configuration')
  const { inspectVersion } = createWorkerFileEffects({ root, workerOwned, maxBytes, authorization: { consume: () => false } })
  const dispatches = new AsyncLocalStorage()
  const isLive = binding => binding?.open === true && !binding.signal.aborted && binding.turn.isCurrent()
  const dispatch = createWorkerFileDispatch({ root, workerOwned, readRules, adjudicate, maxBytes,
    isAuthorized(action) {
      const current = dispatches.getStore()
      return isLive(current) && action.dispatchId === current.callId
        && ['personId', 'botId', 'roomId', 'sessionId', 'requestId'].every(key => current.turn[key] === action[key])
        && isAuthorized(action) === true
    },
  })

  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== name || exec.parent !== undefined || !exec.callId || exec.rootCallId !== exec.callId
        || typeof exec.token !== 'symbol' || exec.signal.aborted || dispatches.getStore()) throw refused()
    const content = contentOf(exec.arguments)
    if (content === undefined || Buffer.byteLength(content) > maxBytes) throw refused()
    const turn = currentTurn(exec.agent)
    if (!turn) throw refused()
    const binding = { turn, callId: exec.callId, token: exec.token, signal: exec.signal, content, open: true, used: false }
    try { return await dispatches.run(binding, next) } finally { binding.open = false }
  }, { prepend: true })

  ctx.tools.register({
    name, description: 'Replace the text in the worker’s configured business file',
    parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: text => [{ type: 'text', text }] },
    async execute(args, exec) {
      const binding = dispatches.getStore()
      if (!isLive(binding) || binding.used || exec.token !== binding.token || exec.callId !== binding.callId
          || exec.rootCallId !== binding.callId || exec.parent !== undefined
          || contentOf(args) !== binding.content) throw refused()
      binding.used = true
      const { personId, botId, roomId, sessionId, requestId } = binding.turn
      try {
        await dispatch({ personId, botId, roomId, sessionId, requestId, dispatchId: binding.callId }, {
          operation: 'modify', path, version: inspectVersion(path), content: Buffer.from(binding.content),
        })
      } catch (error) {
        if (error?.code === 'file-effect-unknown') throw new Error('Worker file outcome unknown')
        throw refused()
      }
      return 'File updated'
    },
  })
}

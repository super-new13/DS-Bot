import { isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { startLocalWorkerRuntime } from './worker-runtime.js'

export const name = 'enterprise-worker'

// A trusted bootstrap supplies the model adapter, TLS material and live grants.
// The plugin owns a fresh Context with no inherited profile services.
export async function apply(_profile, config = {}) {
  const { provider, model, adapter, tls, receiptPath, mappingPath, sessionRoot, authorizePeer, authorizeSession, onReady, ...options } = config
  if (typeof provider !== 'string' || !provider.trim() || typeof model !== 'string' || !model.trim()
      || typeof adapter?.stream !== 'function' || typeof adapter.resolveModel !== 'function'
      || typeof authorizePeer !== 'function' || typeof authorizeSession !== 'function'
      || typeof receiptPath !== 'string' || !isAbsolute(receiptPath) || !tls?.ca || !tls.cert || !tls.key
      || (onReady !== undefined && typeof onReady !== 'function')) {
    throw new TypeError('Invalid enterprise worker plugin configuration')
  }
  if ((mappingPath !== undefined || sessionRoot !== undefined)
      && (typeof mappingPath !== 'string' || !isAbsolute(mappingPath) || typeof sessionRoot !== 'string' || !isAbsolute(sessionRoot))) {
    throw new TypeError('Expected absolute worker mapping and persistence paths')
  }
  const ctx = new Context()
  let runtime
  try {
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter([provider], adapter)
    await ctx.llm.resolveModelInfo(provider, model)
    await ctx.plugin(SessionStore)
    if (sessionRoot !== undefined) await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot, compression: 'none' })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    runtime = await startLocalWorkerRuntime({ ...options, ctx, provider, model, tls, receiptPath, mappingPath, sessionRoot, authorizePeer, authorizeSession })
    await onReady?.(Object.freeze({ origin: runtime.origin }))
    return runtime.close
  } catch (error) {
    if (runtime) await runtime.close()
    else await ctx.fiber.dispose()
    throw error
  }
}

#!/usr/bin/env node
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

async function startPolicy(options) {
  const { startFilePolicyRuntime } = await import('../src/host/enterprise/file-policy-runtime.js')
  const { onReady, ...policy } = options
  if (onReady !== undefined && typeof onReady !== 'function') throw new TypeError('Invalid readiness callback')
  const runtime = await startFilePolicyRuntime({ ...policy, trustedProducer: Symbol('local policy producer') })
  try {
    const { origin, evidenceOrigin, revoke } = runtime
    await onReady?.(Object.freeze({ origin, evidenceOrigin, revoke }))
    return { close: runtime.close, origin, evidenceOrigin }
  } catch (error) {
    await runtime.close()
    throw error
  }
}

async function startWorker(options) {
  const { Context } = await import('@deepseek-ai/cordis')
  const { createWorkerBootstrap } = await import('../src/host/enterprise/worker-bootstrap.js')
  const { onReady, ...worker } = options
  if (onReady !== undefined && typeof onReady !== 'function') throw new TypeError('Invalid readiness callback')
  const profile = new Context()
  let ready
  try {
    const bootstrap = createWorkerBootstrap({ ...worker, async onReady(value) {
      ready = value
      await onReady?.(value)
    } })
    const dispose = await bootstrap.apply(profile)
    return { origin: ready.origin, async close() {
      try { await dispose() } finally { await profile.fiber.dispose() }
    } }
  } catch (error) {
    await profile.fiber.dispose()
    throw error
  }
}

async function main(args) {
  const [role, flag, configPath] = args
  if (args.length !== 3 || !['policy', 'worker'].includes(role) || flag !== '--config' || !isAbsolute(configPath) || !configPath.endsWith('.mjs')) {
    console.error('Usage: node ds-bot-enterprise-node.mjs <policy|worker> --config /absolute/path.mjs')
    process.exitCode = 2
    return
  }
  const { promise: shutdown, resolve: stop } = Promise.withResolvers()
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  let runtime
  try {
    try {
      if (!(await stat(configPath)).isFile()) throw new TypeError('Expected configuration file')
      const { default: options } = await import(pathToFileURL(configPath).href)
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Expected configuration options')
      const start = role === 'policy' ? startPolicy : startWorker
      runtime = await start(options)
    } catch {
      console.error('Enterprise node could not start. Check service configuration and file permissions.')
      process.exitCode = 1
      return
    }
    console.log(JSON.stringify({ role, origin: runtime.origin, evidenceOrigin: runtime.evidenceOrigin }))
    await shutdown
    try { await runtime.close() } catch {
      console.error('Enterprise node shutdown failed.')
      process.exitCode = 1
    }
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
}

await main(process.argv.slice(2))

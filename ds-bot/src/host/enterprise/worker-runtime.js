import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { openWorkerSessionMapping } from './session-mapping.js'
import { openWorkerReceiptStore } from './receipt-store.js'
import { createWorkerHttpHandler } from './worker-http.js'
import { openWorkerReceipts } from './worker-receipts.js'
import { createWorkerSessionAdapter } from './worker-session.js'
import { startLocalWorkerTls } from './worker-tls.js'

const claimedContexts = new WeakSet()
const activeStores = new Set()
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

// Transfer ownership of a dedicated, isolated DSH Context to this runtime.
// Grants are live, synchronous checks against trusted worker configuration.
export async function startLocalWorkerRuntime({ ctx, nodeId, provider, model, receiptPath, mappingPath, sessionRoot, initialize = false,
  tls, host, port, origin, authorizePeer, authorizeSession, limits = {} }) {
  if (!ctx?.agents || !ctx.fiber || !validId(nodeId) || !provider?.trim() || !model?.trim()
      || typeof receiptPath !== 'string' || !isAbsolute(receiptPath)
      || typeof authorizePeer !== 'function' || typeof authorizeSession !== 'function'
      || !tls?.ca || !tls.cert || !tls.key) throw new TypeError('Invalid local worker runtime configuration')
  if ((mappingPath !== undefined || sessionRoot !== undefined)
      && (!isAbsolute(mappingPath ?? '') || !isAbsolute(sessionRoot ?? '') || !ctx.sessionPersistence)) {
    throw new TypeError('Durable worker sessions require a mapping path and mounted persistence')
  }
  const storePath = join(await realpath(dirname(receiptPath)), basename(receiptPath))
  if (claimedContexts.has(ctx) || activeStores.has(storePath)) throw new Error('Worker Context or receipt store already in use')
  claimedContexts.add(ctx)
  activeStores.add(storePath)
  let listener
  let worker
  let closing
  let closed = false
  const pending = new Set()
  function close() {
    closed = true
    return closing ??= (async () => {
      try {
        await listener?.close()
      } finally {
        try { await worker?.close() } finally {
          try { await ctx.fiber.dispose() } finally {
            await Promise.allSettled(pending)
            activeStores.delete(storePath)
          }
        }
      }
    })()
  }
  try {
    const mapping = mappingPath === undefined ? undefined : await openWorkerSessionMapping(mappingPath, { initialize })
    const store = await openWorkerReceiptStore(storePath, { initialize })
    const receipts = await openWorkerReceipts({ ...store, transact(change) {
      if (closed) throw new Error('Worker runtime closed')
      const operation = store.transact(state => {
        if (closed) throw new Error('Worker runtime closed')
        return change(state)
      })
      pending.add(operation)
      const untrack = () => pending.delete(operation)
      void operation.then(untrack, untrack)
      return operation
    } })
    // This runtime serves model turns only. The dedicated Context owns this guard.
    ctx.on('tools/execute', () => { throw new Error('Tools are disabled on this worker') }, { prepend: true })
    worker = createWorkerSessionAdapter(ctx, { provider, model, nodeId, mapping, sessionRoot,
      authorize: (scope, requestId) => !closed && authorizeSession(Object.freeze({ ...scope, nodeId }), requestId) === true,
    })
    let handle
    const { maxBodyBytes, maxActive, timeoutMs, maxConnections } = limits
    listener = await startLocalWorkerTls({ ...tls, host, port, origin, maxBodyBytes, timeoutMs, maxConnections,
      handler: (request, peer) => handle ? handle(request, peer) : new Response(null, { status: 503 }),
    })
    const scopedReceipts = mapping ? { ...receipts, async admit(scope, ...args) {
      if (!await mapping.owns(scope)) throw Object.assign(new Error('Worker session refused'), { code: 'not-authorized' })
      return receipts.admit(scope, ...args)
    } } : receipts
    handle = createWorkerHttpHandler({ nodeId, origin: listener.origin, worker, receipts: scopedReceipts, maxBodyBytes, maxActive,
      authenticatePeer: peer => peer?.fingerprint,
      authorizePeer: (fingerprint, operation) => !closed && authorizePeer(fingerprint, operation) === true,
    })
    return { origin: listener.origin, address: listener.address, close }
  } catch (error) {
    await close()
    throw error
  }
}

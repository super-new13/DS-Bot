const revocations = new Set(['active', 'pending', 'revoked'])
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const unknown = () => Object.assign(new Error('File settlement delivery outcome unknown'), { code: 'settlement-delivery-unknown' })

function responseField(response, key) {
  if (!record(response) || Reflect.ownKeys(response).length !== 1) return undefined
  return Object.getOwnPropertyDescriptor(response, key)?.value
}

// Pass this callback to the outbox. A confirmed duplicate from the evidence
// store is sufficient for settlement. Deletion still requires a settlement reply.
export function createFileSettlementDelivery({ ingest, reservations } = {}) {
  if (typeof ingest !== 'function' || typeof reservations?.settle !== 'function') {
    throw new TypeError('Expected file evidence ingestion and reservation settlement clients')
  }
  const settle = reservations.settle.bind(reservations)
  return async function deliver(entry, { signal } = {}) {
    const { scope, status, evidenceId } = entry ?? {}
    if (!record(scope) || status !== 'completed' || !validId(evidenceId)) throw new TypeError('Invalid completed file evidence')
    const completed = Object.freeze({ scope: Object.freeze({ ...scope }), status, evidenceId })
    signal?.throwIfAborted()
    const inserted = responseField(await ingest(completed, { signal }), 'inserted')
    signal?.throwIfAborted()
    if (typeof inserted !== 'boolean') throw unknown()
    const result = await settle(completed.scope, completed.status, completed.evidenceId, { signal })
    signal?.throwIfAborted()
    // Pending can describe other reservations after this one was settled.
    if (!revocations.has(responseField(result, 'revocation'))) throw unknown()
    return { inserted }
  }
}

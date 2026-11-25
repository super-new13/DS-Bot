const invalid = () => Object.assign(new Error('Invalid audit query'), { code: 'invalid-audit-query' })
const unavailable = () => Object.assign(new Error('Audit records unavailable'), { code: 'audit-unavailable' })
const queryKeys = new Set(['personId', 'botId', 'operation', 'verdict', 'offset', 'limit'])
const id = value => typeof value === 'string' && value.length <= 256 && value.trim() !== ''

export function createWorkerAuditReader({ workers }) {
  return {
    async readAudit(input, ownerRequestId, authorize, { signal } = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid()
      const { nodeId, ...query } = input
      if (Object.hasOwn(input, 'nodeId') && (typeof nodeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(nodeId))) throw invalid()
      if (Object.keys(query).some(key => !queryKeys.has(key))
          || ![query.personId, query.botId].every(value => value === undefined || id(value))
          || (query.operation !== undefined && !['create', 'modify', 'read'].includes(query.operation))
          || (query.verdict !== undefined && !['allowed', 'denied'].includes(query.verdict))
          || (query.offset !== undefined && (!Number.isSafeInteger(query.offset) || query.offset < 0 || query.offset > 1_000_000))
          || (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100))) throw invalid()
      if (!workers.size) throw unavailable()
      const selected = nodeId ?? (workers.size === 1 ? workers.keys().next().value : undefined)
      if (!workers.has(selected)) throw invalid()
      const client = workers.get(selected)
      if (typeof client?.readAudit !== 'function' || signal?.aborted || (authorize && authorize() !== true)) throw unavailable()
      try {
        return await client.readAudit({ nodeId: selected }, { ownerRequestId, query }, { signal })
      } catch (error) {
        if (error?.code === 'worker-refused' || error?.code === 'worker-outcome-unknown') throw unavailable()
        throw error
      }
    },
  }
}

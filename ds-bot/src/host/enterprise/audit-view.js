import { randomUUID } from 'node:crypto'

export function createOwnerAuditView({ auditStore, isOwner }) {
  if (typeof auditStore?.readAudit !== 'function' || typeof isOwner !== 'function') throw new TypeError('Expected an owner audit store')
  return async function view(context, query) {
    const authorized = () => context != null && isOwner(context) === true
    const refused = () => Object.assign(new Error('Audit read refused'), { code: 'not-authorized' })
    if (!authorized()) throw refused()
    const result = await auditStore.readAudit(query, randomUUID(), authorized)
    if (!authorized()) throw refused()
    return result
  }
}

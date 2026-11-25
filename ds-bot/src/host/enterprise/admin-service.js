import { createOwnerAuditView } from './audit-view.js'
import { readOwnerTranscript } from './transcript-view.js'

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

function refused() {
  return Object.assign(new Error('Employee administration refused'), { code: 'not-authorized' })
}

// The caller supplies authenticated host context separately from the employee ID.
// isOwner and readRoster are synchronous live checks. Reuse the account service
// owned by the runtime so admin and employee operations share one writer.
export function createEmployeeAdminService({ accounts, isOwner, readRoster, auditStore, transcriptStore } = {}) {
  if (typeof accounts?.issueInvite !== 'function' || typeof accounts?.revokeAccount !== 'function'
      || typeof isOwner !== 'function' || typeof readRoster !== 'function') {
    throw new TypeError('Expected live accounts, owner authorization and roster')
  }
  if (auditStore !== undefined && typeof auditStore?.readAudit !== 'function') throw new TypeError('Invalid owner audit store')
  if (transcriptStore !== undefined && typeof transcriptStore?.readAudited !== 'function') throw new TypeError('Invalid private transcript store')

  function requireEmployee(context, personId, inviting) {
    if (!validId(personId)) throw refused()
    const person = readRoster().people[personId]
    if (person?.id !== personId || (inviting && person.revokedAt !== undefined) || isOwner(context) !== true) throw refused()
  }

  const audit = auditStore === undefined ? undefined : createOwnerAuditView({ auditStore, isOwner })

  return {
    audit,
    async transcript(context, filter) {
      if (!context || isOwner(context) !== true || !transcriptStore) throw refused()
      const result = await readOwnerTranscript(transcriptStore, context, filter)
      if (isOwner(context) !== true) throw refused()
      return result
    },
    async invite(context, personId) {
      requireEmployee(context, personId, true)
      return accounts.issueInvite(personId)
    },
    async revoke(context, personId) {
      requireEmployee(context, personId, false)
      return accounts.revokeAccount(personId)
    },
  }
}

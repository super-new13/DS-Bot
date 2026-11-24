const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

function refused() {
  return Object.assign(new Error('Employee account operation refused'), { code: 'not-authorized' })
}

// The caller supplies authenticated host context separately from the employee ID.
// isOwner and readRoster are synchronous live checks. Reuse the account service
// owned by the runtime so admin and employee operations share one writer.
export function createEmployeeAdminService({ accounts, isOwner, readRoster } = {}) {
  if (typeof accounts?.issueInvite !== 'function' || typeof accounts?.revokeAccount !== 'function'
      || typeof isOwner !== 'function' || typeof readRoster !== 'function') {
    throw new TypeError('Expected live accounts, owner authorization and roster')
  }

  function requireEmployee(context, personId, inviting) {
    if (!context || isOwner(context) !== true || !validId(personId)) throw refused()
    const people = readRoster()?.people
    const person = people && Object.hasOwn(people, personId) ? people[personId] : undefined
    if (person?.id !== personId || (inviting && person.revokedAt !== undefined) || isOwner(context) !== true) throw refused()
  }

  return {
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

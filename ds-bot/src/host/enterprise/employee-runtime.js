import { openEmployeeRuleStore } from './rule-store.js'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createStandaloneOwnerHandler } from './admin-route.js'
import { createOwnerAdmission } from './owner-auth.js'
import { openEmployeeTranscriptStore } from './transcript-store.js'
import { openEmployeeAccountStore } from './account-store.js'
import { createEmployeeAccounts } from './accounts.js'
import { loadEmployeeSite } from './employee-site.js'
import { createEmployeeServiceHandler } from './enterprise-service.js'
import { startEnterpriseHttpsEntry } from './https-entry.js'
import { createEnterpriseRuntimeRoster } from './runtime-roster.js'

// The host owns the private directory and worker registry. Use one runtime per account
// file and share its account service with trusted provisioning callers.
export async function startEmployeeRuntime({ accountFile, initializeAccounts = false, readConfig, workers,
  readHistory, enqueueGroup, limits, https, owner, auditStore } = {}) {
  if (typeof accountFile !== 'string' || !isAbsolute(accountFile) || typeof initializeAccounts !== 'boolean') {
    throw new TypeError('Expected an absolute employee account file path and a boolean initialization flag')
  }
  const tls = https?.tls
  if (!tls?.pfx && !(tls?.key && tls?.cert)) throw new TypeError('Expected employee HTTPS certificate and key material')
  const options = { ...https }
  const roster = createEnterpriseRuntimeRoster({ readConfig, workers })
  roster.readRoster()
  let ownerAdmission
  let transcriptStore
  let ruleStore
  if (owner !== undefined) {
    ownerAdmission = createOwnerAdmission({ origin: options.origin, tokenHash: owner?.tokenHash })
    if (typeof owner.transcriptDirectory !== 'string' || !isAbsolute(owner.transcriptDirectory)
        || ((await stat(owner.transcriptDirectory)).mode & 0o077) !== 0) {
      throw new TypeError('Expected a private absolute transcript directory')
    }
    transcriptStore = await openEmployeeTranscriptStore(owner.transcriptDirectory)
    if (owner.ruleFile !== undefined) {
      ruleStore = await openEmployeeRuleStore(owner.ruleFile, { initialize: owner.initializeRules })
    }
  }
  const employeeAsset = await loadEmployeeSite({ owner: Boolean(ownerAdmission) })
  const store = await openEmployeeAccountStore(accountFile, { initialize: initializeAccounts })
  const accounts = createEmployeeAccounts(store)
  const handleOwner = ownerAdmission && createStandaloneOwnerHandler({ accounts, readRoster: roster.readRoster,
    isOwner: ownerAdmission.isOwner, transcriptStore, ruleStore, auditStore })
  const handler = createEmployeeServiceHandler({ origin: options.origin, accounts, ...roster, limits, readHistory, enqueueGroup, transcriptStore, handleOwner })
  const entry = await startEnterpriseHttpsEntry({ ...options, handler, employeeAsset, ownerAdmission })
  return { address: entry.address, close: entry.close, accounts }
}

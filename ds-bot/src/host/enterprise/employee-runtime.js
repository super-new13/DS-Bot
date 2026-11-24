import { isAbsolute } from 'node:path'
import { openEmployeeAccountStore } from './account-store.js'
import { createEmployeeAccounts } from './accounts.js'
import { loadEmployeeSite } from './employee-site.js'
import { createEmployeeServiceHandler } from './enterprise-service.js'
import { startEnterpriseHttpsEntry } from './https-entry.js'
import { createEnterpriseRuntimeRoster } from './runtime-roster.js'

// The host owns the private directory and worker registry. Use one runtime per account
// file and share its account service with trusted provisioning callers.
export async function startEmployeeRuntime({ accountFile, initializeAccounts = false, readConfig, workers,
  readHistory, enqueueGroup, limits, https } = {}) {
  if (typeof accountFile !== 'string' || !isAbsolute(accountFile) || typeof initializeAccounts !== 'boolean') {
    throw new TypeError('Expected an absolute employee account file path and a boolean initialization flag')
  }
  const tls = https?.tls
  if (!tls?.pfx && !(tls?.key && tls?.cert)) throw new TypeError('Expected employee HTTPS certificate and key material')
  const options = { ...https }
  const roster = createEnterpriseRuntimeRoster({ readConfig, workers })
  roster.readRoster()
  const employeeAsset = await loadEmployeeSite()
  const store = await openEmployeeAccountStore(accountFile, { initialize: initializeAccounts })
  const accounts = createEmployeeAccounts(store)
  const handler = createEmployeeServiceHandler({ origin: options.origin, accounts, ...roster, limits, readHistory, enqueueGroup })
  const entry = await startEnterpriseHttpsEntry({ ...options, handler, employeeAsset })
  return { address: entry.address, close: entry.close, accounts }
}

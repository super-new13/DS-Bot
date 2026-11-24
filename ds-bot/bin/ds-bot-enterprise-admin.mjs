#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { openEmployeeAccountStore } from '../src/host/enterprise/account-store.js'
import { createEmployeeAccounts } from '../src/host/enterprise/accounts.js'
import { createEnterpriseRuntimeRoster } from '../src/host/enterprise/runtime-roster.js'

const help = [
  'Usage: node ds-bot/bin/ds-bot-enterprise-admin.mjs --config /absolute/path.json --service-stopped <invite|revoke> <employee-id>',
  '',
  'Stop the employee service and every other writer to the account store before running this command.',
  'Wait for them to exit and keep them stopped until the command finishes.',
  '--service-stopped confirms this requirement. The account store has no cross-process lock.',
  'Use an existing account store and the employee deployment configuration.',
  '',
  'invite writes the one-time code and expiry as JSON to stdout. Capture it privately and deliver it securely.',
  'Keep stdout for invite out of logs and shell tracing. revoke clears the account credentials and sessions.',
].join(String.fromCharCode(10))

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(help)
    return
  }
  const [configFlag, configFile, stoppedFlag, action, personId] = args
  if (args.length !== 5 || configFlag !== '--config' || !isAbsolute(configFile) || configFile.includes('\0')
      || stoppedFlag !== '--service-stopped' || !['invite', 'revoke'].includes(action) || !/^[A-Za-z0-9_-]{1,128}$/.test(personId)) {
    console.error(help)
    process.exitCode = 2
    return
  }
  try {
    const { accountFile, roster } = JSON.parse(await readFile(configFile, 'utf8'))
    if (typeof accountFile !== 'string' || !isAbsolute(accountFile) || accountFile.includes('\0')) throw new TypeError()
    const { people } = createEnterpriseRuntimeRoster({ readConfig: () => roster, workers: new Map() }).readRoster()
    const person = people[personId]
    if (!person || (action === 'invite' && person.revokedAt !== undefined)) {
      console.error('Employee is not eligible for this operation in the configured roster.')
      process.exitCode = 1
      return
    }
    const accounts = createEmployeeAccounts(await openEmployeeAccountStore(accountFile))
    if (action === 'invite') {
      const invitation = await accounts.issueInvite(person.id)
      if (invitation) {
        await new Promise((resolve, reject) => {
          process.stdout.write(JSON.stringify(invitation) + String.fromCharCode(10), error => error ? reject(error) : resolve())
        })
        return
      }
    } else if (await accounts.revokeAccount(person.id)) {
      console.log('Employee account revoked.')
      return
    }
    console.error('The current account state does not allow this operation.')
    process.exitCode = 1
  } catch {
    console.error('Employee account operation could not be confirmed. Check the configuration and account store.')
    process.exitCode = 1
  }
}

process.stdout.on('error', () => { process.exitCode = 1 })
await main(process.argv.slice(2))

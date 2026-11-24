#!/usr/bin/env node
import { isAbsolute } from 'node:path'

async function main(args) {
  const [flag, configFile] = args
  if (args.length !== 2 || flag !== '--config' || !isAbsolute(configFile)) {
    console.error('Usage: node ds-bot/bin/ds-bot-enterprise.mjs --config /absolute/path.json')
    process.exitCode = 2
    return
  }

  const { promise: shutdown, resolve: stop } = Promise.withResolvers()
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    let runtime
    try {
      const { startEmployeeDeployment } = await import('../src/host/enterprise/employee-bootstrap.js')
      runtime = await startEmployeeDeployment(configFile)
    } catch {
      console.error('Employee service could not start. Check deployment configuration and file permissions.')
      process.exitCode = 1
      return
    }
    console.log('Employee HTTPS listening on port ' + runtime.address.port)
    await shutdown
    try {
      await runtime.close()
    } catch {
      console.error('Employee service shutdown failed.')
      process.exitCode = 1
    }
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
}

await main(process.argv.slice(2))

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const launcher = `
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initProfile, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { INSTALL_ANCHOR, runProfile } from '@deepseek-ai/dsh/profile-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'

const home = process.env.DSH_HOME
const profileName = 'enterprise-worker-fixture'
const dir = join(home, 'profiles', profileName)
initProfile(dir, [])
const profile = loadProfileDirectory('dsh', dir, INSTALL_ANCHOR)
assert.deepEqual(profile.skippedBundles, [])
const run = await runProfile({
  profile: profileName,
  resolvedProfile: { profile, installAnchor: INSTALL_ANCHOR },
  environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' } }]),
  patchFiles: [join(home, 'fixture.patch.yml')],
  args: [],
})
let endpoint
try {
  assert.equal(run.ctx.get('webServer'), undefined)
  assert.equal(run.ctx.get('connection'), undefined)
  const ready = JSON.parse(readFileSync(join(home, 'worker-ready'), 'utf8'))
  assert.equal(ready.profile, profileName)
  assert.equal(ready.address, '127.0.0.1')
  endpoint = 'http://' + ready.address + ':' + ready.port
  assert.equal(await (await fetch(endpoint, { signal: AbortSignal.timeout(3000) })).text(), 'mock worker')
  assert.equal(existsSync(join(home, 'worker-stopped')), false)
} finally {
  await Promise.all([run.shutdown.shutdown(0), run.shutdown.shutdown(0)])
}
assert.equal(readFileSync(join(home, 'worker-stopped'), 'utf8'), 'closed')
await assert.rejects(fetch(endpoint, { signal: AbortSignal.timeout(3000) }), error => error.cause?.code === 'ECONNREFUSED')
`

const plugin = `
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
export async function apply() {
  const home = process.env.DSH_HOME
  const server = createServer((_req, res) => res.end('mock worker'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  writeFileSync(join(home, 'worker-ready'), JSON.stringify({ profile: 'enterprise-worker-fixture', ...server.address() }))
  return async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    writeFileSync(join(home, 'worker-stopped'), 'closed')
  }
}
`

test('boots and disposes an isolated headless DSH worker plugin', { timeout: 20000 }, t => {
  const home = mkdtempSync(join(tmpdir(), 'dsbot-plugin-profile-'))
  t.after(() => rmSync(home, { force: true, recursive: true }))
  const harness = resolve(process.env.DSH_HARNESS ?? fileURLToPath(new URL('../dev/harness/', import.meta.url)))
  symlinkSync(join(harness, 'node_modules'), join(home, 'node_modules'), 'junction')
  writeFileSync(join(home, 'boot.mjs'), launcher)
  writeFileSync(join(home, 'worker.mjs'), plugin)
  writeFileSync(join(home, 'fixture.patch.yml'), '- insert:\n    - id: enterprise-worker-fixture\n      name: ' + JSON.stringify(join(home, 'worker.mjs')) + '\n')
  execFileSync(process.execPath, [join(home, 'boot.mjs')], {
    cwd: home, timeout: 15000,
    env: { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }) },
  })
})

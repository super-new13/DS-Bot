import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, chmod } from 'node:fs/promises'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const cwd = fileURLToPath(new URL('../', import.meta.url))
const name = 'dsbot-pilot-smoke-' + randomUUID()
const image = name + ':local'
const origin = 'https://127.0.0.1:18443'
const control = new AbortController()
const stop = () => control.abort()

async function fixture(dir) {
  const configDir = join(dir, 'config')
  await mkdir(configDir, { mode: 0o755 })
  const key = join(configDir, 'fixture.key')
  const cert = join(configDir, 'fixture.pem')
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=DS Bot smoke fixture',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { cwd, timeout: 10000, signal: control.signal })
  const config = {
    accountFile: '/home/node/accounts.json', initializeAccounts: true,
    https: { origin, host: '0.0.0.0', port: 8443,
      keyFile: '/run/dsbot-enterprise/fixture.key', certFile: '/run/dsbot-enterprise/fixture.pem' },
    workers: [], roster: { people: {}, bots: {}, rooms: {} },
    limits: { maxActive: 1, maxPerBot: 1, maxPerNode: 1, maxPending: 0 },
  }
  const configFile = join(configDir, 'config.json')
  await writeFile(configFile, JSON.stringify(config))
  // The fixture is disposable. Docker mounts only this directory for UID 1000.
  await Promise.all([chmod(configDir, 0o755), ...[key, cert, configFile].map(path => chmod(path, 0o444))])
  return { configDir, ca: await readFile(cert) }
}

function checkConfig(model, configDir) {
  const pilot = model.services['employee-pilot']
  assert.deepEqual(model.services.dsh.ports ?? [], [])
  assert.equal(model.services.dsh.network_mode, undefined)
  assert.equal(pilot.image, image)
  assert.equal(pilot.depends_on, undefined)
  assert.deepEqual(pilot.ports.map(({ host_ip, published, target, protocol }) => [host_ip, String(published), target, protocol]),
    [['127.0.0.1', '18443', 8443, 'tcp']])
  assert.deepEqual(pilot.volumes.map(({ type, source, target }) => [type, source, target]), [
    ['bind', configDir, '/run/dsbot-enterprise'], ['volume', 'enterprise-employee-data', '/home/node'],
  ])
  assert.equal(pilot.volumes[0].read_only, true)
  for (const [key, volume] of Object.entries(model.volumes)) {
    assert.equal(volume.name, name + '_' + key)
    assert.equal(volume.external, undefined)
    assert.equal(volume.driver_opts, undefined)
  }
}

function get(path, ca) {
  return new Promise((resolve, reject) => {
    const req = request(origin + path, { ca, agent: false, signal: AbortSignal.any([control.signal, AbortSignal.timeout(2000)]) }, res => {
      const authorized = res.socket.authorized
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ authorized, status: res.statusCode, type: res.headers['content-type'], text: Buffer.concat(chunks).toString() }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

async function checkHttps(ca) {
  let page
  for (let attempt = 0; attempt < 30; attempt++) {
    try { page = await get('/', ca); break } catch (error) {
      if (error.code !== 'ECONNREFUSED' && error.code !== 'ECONNRESET') throw error
      await delay(250, undefined, { signal: control.signal })
    }
  }
  assert.equal(page?.authorized, true)
  assert.equal(page.status, 200)
  assert.match(page.type, /^text\/html/)
  assert.match(page.text, /DS Bot · Employee/)
  assert.equal((await get('/api.js', ca)).status, 200)
  assert.equal((await get('/api/enterprise/auth/session', ca)).status, 401)
  assert.equal((await get('/api/bot', ca)).status, 404)
}

async function main(args) {
  if (args.length !== 1 || !['--config-only', '--run'].includes(args[0])) {
    console.error('Usage: node docker/test-enterprise-smoke.mjs --config-only | --run')
    return 2
  }
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsbot-pilot-smoke-')))
  let started = false
  let result = 0
  let stage = 'generate disposable configuration and TLS files'
  let compose
  let docker
  try {
    const { configDir, ca } = await fixture(dir)
    const override = join(dir, 'smoke.compose.json')
    await writeFile(override, JSON.stringify({ services: { 'employee-pilot': { image } } }))
    const env = { ...process.env, COMPOSE_PROFILES: '', DSBOT_ENTERPRISE_CONFIG_DIR: configDir }
    docker = (argv, timeout = 10000, signal = control.signal) => run('docker', argv, { cwd, env, timeout, signal })
    compose = (argv, timeout, signal) => docker(['compose', '--env-file', '/dev/null', '-p', name, '--profile', 'employee-pilot',
      '-f', 'compose.enterprise.yml', '-f', override, ...argv], timeout, signal)
    stage = 'validate the rendered Compose model'
    try {
      await docker(['compose', 'version'])
    } catch {
      console.error('BLOCKED: Docker CLI with Compose is required.')
      return 77
    }
    checkConfig(JSON.parse((await compose(['config', '--format', 'json'])).stdout), configDir)
    console.log('PASS: Compose model exposes only employee loopback HTTPS and uses project-scoped data.')
    if (args[0] === '--config-only') return 0
    stage = 'check the local Docker engine'
    try {
      const endpoint = env.DOCKER_CONTEXT || !env.DOCKER_HOST
        ? (await docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])).stdout.trim()
        : env.DOCKER_HOST
      if (!endpoint.startsWith('unix:///')) throw new Error('Expected a local Unix socket')
      await docker(['version', '--format', '{{.Server.Version}}'])
    } catch {
      console.error('BLOCKED: A reachable local Docker engine on a Unix socket is required.')
      return 77
    }
    stage = 'build and start the isolated employee pilot'
    started = true
    await compose(['up', '--build', '--detach', '--no-deps', 'employee-pilot'], 600000)
    stage = 'verify the running project and published ports'
    const ids = (await compose(['ps', '--all', '--quiet'])).stdout.trim().split(/\s+/)
    assert.equal(ids.length, 1)
    assert.match(ids[0], /^[a-f0-9]{12,64}$/)
    const [container] = JSON.parse((await docker(['inspect', ids[0]])).stdout)
    assert.equal(container.Config.Labels['com.docker.compose.project'], name)
    assert.equal(container.Config.Labels['com.docker.compose.service'], 'employee-pilot')
    assert.deepEqual(Object.entries(container.NetworkSettings.Ports).filter(([, bindings]) => bindings?.length), [
      ['8443/tcp', [{ HostIp: '127.0.0.1', HostPort: '18443' }]],
    ])
    stage = 'verify pilot and API responses over certificate-verified HTTPS'
    await checkHttps(ca)
    console.log('PASS: Employee page and API share verified HTTPS. The project publishes no DSH port.')
  } catch {
    console.error('FAIL: Could not ' + stage + '.')
    result = 1
  } finally {
    if (started) {
      const cleanup = new AbortController().signal
      try {
        await compose(['down', '--volumes'], 45000, cleanup)
        console.log('PASS: Removed disposable Compose services and volumes.')
      } catch {
        console.error('FAIL: Compose teardown did not complete for project ' + name + '.')
        result = 1
      }
      await docker(['image', 'rm', image], 10000, cleanup).catch(() => {})
    }
    await rm(dir, { recursive: true, force: true })
  }
  return result
}

process.on('SIGINT', stop)
process.on('SIGTERM', stop)
try { process.exitCode = await main(process.argv.slice(2)) }
finally {
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
}

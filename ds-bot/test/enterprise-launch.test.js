import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'

const host = '127.0.0.1'
const packageDir = new URL('../', import.meta.url)

function call(port, path, ca) {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, ca, agent: false, headers: { host }, signal: AbortSignal.timeout(4000) }, res => {
      const authorized = res.socket.authorized
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, authorized }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

test('the packaged command serves the employee HTTPS origin and handles both shutdown signals', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ds-bot-launch-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const archive = execFileSync('npm', ['pack', '--offline', '--ignore-scripts', '--silent', '--pack-destination', dir],
    { cwd: packageDir, encoding: 'utf8', timeout: 10000 }).trim()
  execFileSync('tar', ['-xzf', join(dir, archive), '-C', dir], { timeout: 5000 })
  const cli = join(dir, 'package', 'bin', 'ds-bot-enterprise.mjs')
  const keyFile = join(dir, 'fixture.key')
  const certFile = join(dir, 'fixture.pem')
  execFileSync('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:' + host, '-keyout', keyFile, '-out', certFile], { stdio: 'ignore', timeout: 5000 })
  const ca = await readFile(certFile)
  const accountFile = join(dir, 'accounts.json')
  const configFile = join(dir, 'fixture-config.json')
  const config = { accountFile, initializeAccounts: true,
    https: { origin: 'https://' + host, host, port: 0, keyFile, certFile }, workers: [],
    roster: { people: {}, bots: {}, rooms: {} }, limits: { maxActive: 1, maxPerBot: 1, maxPerNode: 1, maxPending: 0 } }
  await writeFile(configFile, JSON.stringify(config))

  for (const signal of ['SIGTERM', 'SIGINT']) {
    await t.test(signal, { timeout: 8000 }, async st => {
      const child = spawn(process.execPath, [cli, '--config', configFile], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
      const closed = once(child, 'close')
      st.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await closed
      })
      const lines = createInterface({ input: child.stdout })
      const ready = once(lines, 'line', { signal: AbortSignal.timeout(4000) }).then(([line]) => line)
      const line = await Promise.race([ready, closed.then(() => { throw new Error('Launcher exited before listening') })])
      assert.match(line, /^Employee HTTPS listening on port [1-9][0-9]*$/)
      const port = Number(line.split(' ').at(-1))
      const html = await call(port, '/', ca)
      assert.equal(html.authorized, true)
      assert.equal(html.status, 200)
      assert.match(html.text, /DS Bot · Employee/)
      assert.match(html.headers['content-security-policy'], /connect-src 'self'/)
      assert.equal((await call(port, '/page.js', ca)).status, 200)
      assert.equal((await call(port, '/api/enterprise/auth/session', ca)).status, 401)
      assert.equal(child.kill(signal), true)
      assert.deepEqual(await closed, [0, null])
      await assert.rejects(call(port, '/', ca), { code: 'ECONNREFUSED' })
    })
    delete config.initializeAccounts
    await writeFile(configFile, JSON.stringify(config))
  }

  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', timeout: 5000 })
  const usage = invoke('--config', 'fixture-relative.json')
  assert.equal(usage.status, 2)
  assert.equal(usage.stdout, '')
  assert.equal(usage.stderr, 'Usage: node ds-bot/bin/ds-bot-enterprise.mjs --config /absolute/path.json\n')
  config.https.port = 65536
  config.accountFile = join(dir, 'second-accounts.json')
  await writeFile(configFile, JSON.stringify(config))
  const failed = invoke('--config', configFile)
  assert.equal(failed.status, 1)
  assert.equal(failed.stdout, '')
  assert.equal(failed.stderr, 'Employee service could not start. Check deployment configuration and file permissions.\n')
  await assert.rejects(access(config.accountFile), { code: 'ENOENT' })
})

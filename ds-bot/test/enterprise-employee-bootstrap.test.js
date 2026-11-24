import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startEmployeeDeployment } from '../src/host/enterprise/employee-bootstrap.js'
import { createWorkerHttpHandler } from '../src/host/enterprise/worker-http.js'
import { openWorkerReceipts } from '../src/host/enterprise/worker-receipts.js'
import { startLocalWorkerTls } from '../src/host/enterprise/worker-tls.js'

const host = '127.0.0.1'
const origin = 'https://' + host
const auth = '/api/enterprise/auth/'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ds-bot-employee-bootstrap-'))
  const listeners = []
  t.after(async () => {
    try { await Promise.all(listeners.map(listener => listener.close())) }
    finally { await rm(dir, { recursive: true, force: true }) }
  })
  const file = name => join(dir, name)
  const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore', timeout: 5000 })
  openssl('req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '1', '-subj', '/CN=Bootstrap fixture CA',
    '-keyout', 'ca.key', '-out', 'ca.pem')
  async function sign(name, usage) {
    openssl('req', '-new', '-nodes', '-newkey', 'rsa:2048', '-subj', '/CN=' + name,
      '-keyout', name + '.key', '-out', name + '.csr')
    const extensions = ['basicConstraints=CA:FALSE', 'extendedKeyUsage=' + usage, 'subjectAltName=IP:' + host]
    await writeFile(file(name + '.ext'), extensions.join(String.fromCharCode(10)))
    openssl('x509', '-req', '-in', name + '.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-days', '1', '-extfile', name + '.ext', '-out', name + '.pem')
    return { certFile: file(name + '.pem'), keyFile: file(name + '.key') }
  }
  const server = await sign('server', 'serverAuth')
  const controller = await sign('controller', 'clientAuth')
  const caFile = file('ca.pem')
  const ca = await readFile(caFile)
  const configFile = file('deployment.json')
  const config = {
    accountFile: file('accounts.json'), initializeAccounts: true,
    https: { origin, host, port: 0, ...server },
    workers: [{ nodeId: 'worker', origin: origin + ':12345', caFile, ...controller }],
    limits: { maxActive: 1, maxPerBot: 1, maxPerNode: 1, maxPending: 2 },
    roster: { people: { employee: { id: 'employee', name: 'Employee', botIds: ['helper'] } },
      bots: { helper: { id: 'helper', nodeId: 'worker' } }, rooms: {} },
  }
  const scopes = []
  async function startWorker() {
    let handler
    const entry = await startLocalWorkerTls({ ca, cert: await readFile(server.certFile), key: await readFile(server.keyFile),
      handler: (...args) => handler(...args) })
    listeners.push(entry)
    let saved = { version: 1, generation: null, receipts: {} }
    const receipts = await openWorkerReceipts({ read: () => structuredClone(saved), transact(change) {
      const next = structuredClone(saved)
      const result = change(next)
      saved = next
      return result
    } })
    const controllerIdentity = new X509Certificate(await readFile(controller.certFile)).fingerprint256
    handler = createWorkerHttpHandler({ nodeId: 'worker', origin: entry.origin, receipts,
      authenticatePeer: peer => peer.fingerprint === controllerIdentity ? 'controller' : undefined,
      authorizePeer: (peer, { scope }) => peer === 'controller' && scope.personId === 'employee' && scope.botId === 'helper',
      worker: {
        create: scope => ({ ...scope, sessionId: 'mock-session' }),
        submit({ personId, botId, sessionId, requestId, text }, emit) {
          scopes.push({ personId, botId, sessionId })
          emit({ type: 'reply', sessionId, requestId, text: 'Mock: ' + text })
          return { sessionId, requestId, status: 'completed' }
        },
        cancel: () => ({ accepted: false }),
      },
    })
    config.workers[0].origin = entry.origin
  }
  async function save(value = config) {
    await writeFile(configFile, JSON.stringify(value))
  }
  async function start() {
    await save()
    const runtime = await startEmployeeDeployment(configFile)
    listeners.push(runtime)
    return runtime
  }
  async function call(runtime, path, { cookie, json } = {}) {
    const body = json === undefined ? undefined : JSON.stringify(json)
    const response = await new Promise((resolve, reject) => {
      const req = request({ host, port: runtime.address.port, path, ca, agent: false,
        method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(4000),
        headers: { host, ...(cookie && { cookie }), ...(body !== undefined && {
          origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        }) },
      }, resolve)
      req.on('error', reject)
      req.end(body)
    })
    assert.equal(response.socket.authorized, true)
    const text = (await Array.fromAsync(response.setEncoding('utf8'))).join('')
    return { status: response.statusCode, headers: response.headers, text }
  }
  return { config, configFile, file, scopes, startWorker, save, start, call }
}

test('configured employee HTTPS serves the pilot and routes chat through mTLS', { timeout: 15000 }, async t => {
  const { config, startWorker, start, call, scopes } = await fixture(t)
  await startWorker()
  const runtime = await start()
  assert.match((await call(runtime, '/')).text, /DS Bot/)
  const password = 'disposable deployment fixture password'
  const { token } = await runtime.accounts.issueInvite('employee')
  assert.equal((await call(runtime, auth + 'redeem', { json: { token, password } })).status, 204)
  const login = await call(runtime, auth + 'login', { json: { personId: 'employee', password } })
  assert.equal(login.status, 204)
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0]
  const chat = await call(runtime, '/api/enterprise/private-chat/send', { cookie, json: { botId: 'helper', text: 'configured chat' } })
  assert.equal(chat.status, 200)
  const frames = chat.text.trim().split('\n\n').map(frame => JSON.parse(frame.slice('data: '.length)))
  assert.deepEqual(frames.map(frame => frame.type), ['queued', 'reply', 'done'])
  assert.equal(frames[1].text, 'Mock: configured chat')
  assert.equal(frames[2].status, 'completed')
  assert.deepEqual(scopes, [{ personId: 'employee', botId: 'helper', sessionId: 'mock-session' }])
  assert.equal((await call(runtime, '/api/enterprise/group-chat/general/history', { cookie })).status, 403)

  await runtime.close()
  delete config.initializeAccounts
  const restarted = await start()
  assert.deepEqual(JSON.parse((await call(restarted, auth + 'session', { cookie })).text), { personId: 'employee' })
})

test('invalid configuration fails before account initialization', { timeout: 15000 }, async t => {
  const { config, configFile, file, save } = await fixture(t)
  await assert.rejects(startEmployeeDeployment('relative.json'), /absolute JSON file path/)
  await writeFile(configFile, '{invalid')
  await assert.rejects(startEmployeeDeployment(configFile), /could not read JSON file/)
  const malformed = file('invalid.pem')
  await writeFile(malformed, 'invalid fixture certificate')
  const cases = [
    [value => { value.accountFile = 'relative.json' }, /accounts/],
    [value => { value.initializeAccounts = 'yes' }, /accounts/],
    [value => { value.https.keyFile = value.workers[0].keyFile }, /employee listener TLS material/],
    [value => { value.https.certFile = file('absent.pem') }, /employee listener TLS cert file/],
    [value => { value.workers[0].caFile = malformed }, /worker client TLS material/],
    [value => { value.workers[0].origin = 'http://127.0.0.1' }, /workers/],
    [value => { value.workers.push(value.workers[0]) }, /duplicate worker node/],
    [value => { value.roster.bots.helper.nodeId = 'missing' }, /Bot worker mapping/],
    [value => { value.roster.rooms.general = {} }, /empty rooms table/],
    [value => { value.limits.maxPending = -1 }, /dispatch limits/],
    [value => { delete value.initializeAccounts }, /ENOENT/],
  ]
  for (const [change, error] of cases) {
    const value = structuredClone(config)
    change(value)
    await save(value)
    await assert.rejects(startEmployeeDeployment(configFile), error)
    await assert.rejects(access(config.accountFile), { code: 'ENOENT' })
  }
})

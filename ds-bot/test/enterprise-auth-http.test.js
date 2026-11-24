import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEmployeeAuthHandler } from '../src/host/enterprise/auth-http.js'
import { createEmployeeAccounts } from '../src/host/enterprise/accounts.js'

const origin = 'https://employee.example.test'
const base = origin + '/api/enterprise/auth/'
const password = 'mock employee password'

function post(path, body, headers = {}, target = base) {
  return new Request(target + path, {
    method: 'POST', body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  })
}

function session(cookie) {
  return new Request(base + 'session', { headers: cookie ? { Cookie: cookie } : {} })
}

function fixture() {
  let state = { accounts: {}, sessions: [] }
  const accounts = createEmployeeAccounts({
    read: () => structuredClone(state),
    transact: change => {
      const next = structuredClone(state)
      const result = change(next)
      state = next
      return result
    },
  })
  return { accounts, handle: createEmployeeAuthHandler({ accounts, origin }) }
}

test('redeems once, logs in with a secure cookie and invalidates the session at logout', async () => {
  const { handle, accounts } = fixture()
  const { token } = await accounts.issueInvite('alice')
  assert.equal((await handle(post('redeem', { token, password }))).status, 204)
  const replay = await handle(post('redeem', { token, password }))
  const badPassword = await handle(post('login', { personId: 'alice', password: 'wrong' }))
  const unknown = await handle(post('login', { personId: 'unknown', password }))
  for (const response of [replay, badPassword, unknown]) {
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'Invalid credentials' })
    assert.equal(response.headers.has('set-cookie'), false)
  }

  const login = await handle(post('login', { personId: 'alice', password }))
  assert.equal(login.status, 204)
  assert.equal(await login.text(), '')
  const parts = login.headers.get('set-cookie').split('; ')
  assert.ok(/^__Host-dsbot-employee=[A-Za-z0-9_-]{43}$/.test(parts[0]))
  assert.deepEqual(parts.slice(1).filter(part => !part.startsWith('Max-Age=')), ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict'])
  assert.ok(parts.some(part => /^Max-Age=[1-9]\d*$/.test(part)))
  const [cookie] = parts
  const resolved = await handle(session(cookie))
  assert.equal(resolved.status, 200)
  assert.deepEqual(await resolved.json(), { personId: 'alice' })
  assert.equal(resolved.headers.get('cache-control'), 'no-store')
  assert.equal((await handle(session(cookie + '; ' + cookie))).status, 401)
  assert.equal((await handle(session())).status, 401)

  const logout = await handle(post('logout', undefined, { Cookie: cookie }))
  assert.equal(logout.status, 204)
  assert.equal(logout.headers.get('set-cookie'), '__Host-dsbot-employee=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict')
  assert.equal((await handle(session(cookie))).status, 401)
  assert.equal((await handle(post('logout', undefined, { Cookie: cookie }))).status, 204)
})

test('mutation requests require the exact public origin and routes enforce methods', async () => {
  const noCall = () => assert.fail('Guarded request reached the account service')
  const handle = createEmployeeAuthHandler({ origin, accounts: { login: noCall, redeemInvite: noCall, resolveSession: noCall } })
  for (const path of ['login', 'redeem', 'logout']) {
    for (const foreign of ['https://sibling.example.test', 'http://employee.example.test', 'null']) {
      assert.equal((await handle(post(path, undefined, { Origin: foreign }))).status, 403)
    }
    assert.equal((await handle(new Request(base + path, { method: 'POST' }))).status, 403)
    assert.equal((await handle(post(path, undefined, { 'Sec-Fetch-Site': 'same-site' }))).status, 403)
    assert.equal((await handle(post(path, undefined, {}, 'https://wrong.example.test/api/enterprise/auth/'))).status, 403)
    const getMutation = await handle(new Request(base + path))
    assert.equal(getMutation.status, 405)
    assert.equal(getMutation.headers.get('allow'), 'POST')
  }
  assert.equal((await handle(post('session'))).status, 405)
  assert.equal((await handle(post('login/'))).status, 404)
  assert.equal((await handle(post('login?unexpected=value'))).status, 400)
  assert.equal((await handle(new Request(base + 'login', { method: 'OPTIONS' }))).headers.has('access-control-allow-origin'), false)
})

test('rejects large, non-JSON and malformed bodies before invoking the account service', async () => {
  let calls = 0
  const handle = createEmployeeAuthHandler({ origin, maxBodyBytes: 128, accounts: { login: () => { calls++ } } })
  const good = { personId: 'alice', password }
  const headers = { Origin: origin, 'Content-Type': 'application/json' }
  assert.equal((await handle(post('login', good, { 'Content-Length': '129' }))).status, 413)
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(100))
    controller.enqueue(new Uint8Array(29))
    controller.close()
  } })
  const streamed = new Request(base + 'login', { method: 'POST', headers: { ...headers, 'Content-Length': '1' }, body: stream, duplex: 'half' })
  assert.equal((await handle(streamed)).status, 413)
  assert.equal((await handle(post('login', good, { 'Content-Type': 'text/plain' }))).status, 415)
  assert.equal((await handle(post('login', good, { 'Content-Encoding': 'gzip' }))).status, 415)
  assert.equal((await handle(new Request(base + 'login', { method: 'POST', headers, body: '{' }))).status, 400)
  assert.equal((await handle(post('login', { ...good, extra: 'field' }))).status, 400)
  assert.equal((await handle(post('logout', { ignored: 'body' }))).status, 400)
  assert.equal(calls, 0)
})

test('limits credential attempts per client, across routes and globally before account work', async () => {
  let time = 1000
  let calls = 0
  const count = () => { calls++ }
  const options = { origin, now: () => time, accounts: { login: count, redeemInvite: count }, windowMs: 2000 }
  const handle = createEmployeeAuthHandler({ ...options, clientLimit: 1, globalLimit: 2 })
  const login = { personId: 'alice', password }
  assert.equal((await handle(post('login', login), { clientKey: 'peer-a' })).status, 401)
  const peerLimited = await handle(post('redeem', { token: 'mock invite', password }), { clientKey: 'peer-a' })
  assert.equal(peerLimited.status, 429)
  assert.equal(peerLimited.headers.get('retry-after'), '2')
  assert.equal((await handle(post('login', login), { clientKey: 'peer-b' })).status, 401)
  assert.equal((await handle(post('login', login), { clientKey: 'peer-c' })).status, 429)
  assert.equal(calls, 2)
  time += 2000
  assert.equal((await handle(post('login', login), { clientKey: 'peer-a' })).status, 401)

  const bounded = createEmployeeAuthHandler({ ...options, maxClients: 1, clientLimit: 2 })
  assert.equal((await bounded(post('login', login, { 'X-Forwarded-For': 'ignored-a' }))).status, 401)
  assert.equal((await bounded(post('login', login), { clientKey: 'peer-d' })).status, 429)
  assert.equal((await bounded(post('login', login, { 'X-Forwarded-For': 'ignored-b' }))).status, 401)
  assert.equal((await bounded(post('login', login, { 'X-Forwarded-For': 'ignored-c' }))).status, 429)
  assert.equal(calls, 5)
})

test('caps concurrent credential work and returns sanitized failures when the service throws', async () => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let calls = 0
  const handle = createEmployeeAuthHandler({ origin, maxConcurrent: 1, accounts: {
    async login() {
      calls++
      entered.resolve()
      await release.promise
      throw new Error(password)
    },
  } })
  const login = { personId: 'alice', password }
  const first = handle(post('login', login))
  await entered.promise
  const busy = await handle(post('login', login))
  release.resolve()
  assert.equal(busy.status, 429)
  const unavailable = await first
  assert.equal(unavailable.status, 503)
  assert.deepEqual(await unavailable.json(), { error: 'Authentication unavailable' })
  assert.equal(unavailable.headers.has('set-cookie'), false)
  assert.equal(calls, 1)
  assert.equal((await handle(post('login', login))).status, 503)
  assert.equal(calls, 2)
})

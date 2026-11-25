import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openEmployeeAccountStore } from '../src/host/enterprise/account-store.js'
import { createEmployeeAccounts } from '../src/host/enterprise/accounts.js'
import { openFileAuditStore } from '../src/host/enterprise/file-audit-store.js'
import { registerEmployeeAdminRoute } from '../src/host/enterprise/admin-route.js'

const path = '/api/bot/enterprise-admin'
const origin = 'https://owner.invalid'
const ownerCookie = 'mock-owner=fixture'
const employeeCookie = '__Host-dsbot-employee=fixture'

function mockDsh() {
  let route
  let dispose
  let admitted = 0
  const ctx = { effect(install) { dispose = install() }, connection: { fetch: { register(value) {
    route = value
    return async () => { route = undefined }
  } } } }
  // DSH 0.2.2-rc.1 checks trust and owner admission before calling fetch(request).
  async function dispatch(request) {
    const noStore = { 'Cache-Control': 'no-store' }
    if (!route || new URL(request.url).pathname !== route.path || !route.methods.includes(request.method)) {
      return new Response(null, { status: 404 })
    }
    if (request.headers.get('origin') !== origin) return new Response(null, { status: 403, headers: noStore })
    if (request.headers.get('cookie') !== ownerCookie) return new Response(null, { status: 401, headers: noStore })
    admitted++
    return route.fetch(request)
  }
  return { ctx, dispatch, dispose: () => dispose(), get route() { return route }, get admitted() { return admitted } }
}

function call(dsh, body, { cookie = ownerCookie, site = origin, method = 'POST', route = path } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: site }
  if (cookie) headers.Cookie = cookie
  return dsh.dispatch(new Request(origin + route, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined }))
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsbot-admin-route-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'accounts.json')
  const accounts = createEmployeeAccounts(await openEmployeeAccountStore(file, { initialize: true }))
  const readRoster = () => ({ people: { alice: { id: 'alice' } } })
  return { file, accounts, readRoster }
}

const invite = { operation: 'invite', personId: 'alice' }

test('exact owner route invites and revokes through the live account service', async t => {
  const { accounts, readRoster, file } = await fixture(t)
  const dsh = mockDsh()
  registerEmployeeAdminRoute(dsh.ctx, { accounts, readRoster })
  assert.equal(dsh.route.path, path)
  assert.deepEqual(dsh.route.methods, ['POST'])
  assert.equal(dsh.route.requestBody, 'buffered')
  const result = await call(dsh, invite)
  assert.equal(result.status, 201)
  assert.equal(result.headers.get('cache-control'), 'no-store')
  const { token, expiresAt } = await result.json()
  assert.ok(typeof token === 'string' && expiresAt > Date.now())
  assert.ok(!(await readFile(file, 'utf8')).includes(token))
  const password = 'temporary test password'
  assert.deepEqual(await accounts.redeemInvite(token, password), { personId: 'alice' })
  const session = await accounts.login('alice', password)
  assert.ok(session)
  const revoked = await call(dsh, { operation: 'revoke', personId: 'alice' })
  assert.equal(revoked.status, 204)
  assert.equal(revoked.headers.get('cache-control'), 'no-store')
  assert.equal(await accounts.resolveSession(session.token), undefined)
  await dsh.dispose()
  assert.equal((await call(dsh, invite)).status, 404)
})

test('DSH admission and exact operation allowlist refuse unauthorized requests', async t => {
  const { accounts, readRoster, file } = await fixture(t)
  const dsh = mockDsh()
  registerEmployeeAdminRoute(dsh.ctx, { accounts, readRoster })
  const before = await readFile(file, 'utf8')
  assert.equal((await call(dsh, invite, { cookie: employeeCookie })).status, 401)
  assert.equal((await call(dsh, invite, { cookie: null })).status, 401)
  assert.equal((await call(dsh, invite, { site: 'https://foreign.invalid' })).status, 403)
  assert.equal((await call(dsh, invite, { method: 'GET' })).status, 404)
  assert.equal((await call(dsh, invite, { route: path + '/extra' })).status, 404)
  assert.equal(dsh.admitted, 0)
  for (const [input, status] of [
    [{ ...invite, operation: 'constructor' }, 403],
    [{ ...invite, operation: 'reset' }, 403],
    [{ ...invite, personId: 'unknown' }, 403],
    [{ ...invite, context: { role: 'owner' } }, 400],
  ]) {
    const denied = await call(dsh, input)
    assert.equal(denied.status, status)
    assert.equal(denied.headers.get('cache-control'), 'no-store')
  }
  assert.equal(await readFile(file, 'utf8'), before)
})

test('route never logs invitation or backend diagnostic material', async t => {
  const { accounts, readRoster } = await fixture(t)
  const logs = ['log', 'error', 'warn', 'info', 'debug'].map(name => t.mock.method(console, name, () => {}))
  const dsh = mockDsh()
  const marker = 'disposable sensitive diagnostic'
  registerEmployeeAdminRoute(dsh.ctx, { readRoster, accounts: { ...accounts, revokeAccount() { throw new Error(marker) } } })
  assert.equal((await call(dsh, invite)).status, 201)
  const error = await call(dsh, { operation: 'revoke', personId: 'alice' })
  assert.equal(error.status, 500)
  assert.equal(error.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await error.json(), { error: 'Account operation could not be confirmed' })
  assert.ok(logs.every(log => log.mock.callCount() === 0))
})

test('owner audit reads filter and paginate redacted entries and persist each view', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsbot-owner-audit-'))
  const file = join(dir, 'audit.json')
  const auditStore = await openFileAuditStore(file, { initialize: true })
  t.after(async () => {
    await auditStore.close()
    await rm(dir, { recursive: true, force: true })
  })
  const { accounts, readRoster } = await fixture(t)
  const authorization = { type: 'file-authorization', personId: 'alice', botId: 'helper', roomId: null,
    sessionId: 's1', requestId: 'r1', dispatchId: 'd1', operation: 'modify', ruleId: 'rule', ruleVersion: 'v1', verdict: 'allowed' }
  const effect = { ...authorization, type: 'file-effect', outcome: 'completed' }
  await auditStore.writeAudit(authorization)
  await auditStore.writeAudit({ ...authorization, personId: 'bob' })
  await auditStore.writeAudit({ ...authorization, botId: 'other' })
  await auditStore.writeAudit({ ...authorization, operation: 'read' })
  await auditStore.writeAudit({ ...authorization, verdict: 'denied' })
  await auditStore.writeAudit(effect)
  const dsh = mockDsh()
  registerEmployeeAdminRoute(dsh.ctx, { accounts, readRoster, auditStore })
  const query = { personId: 'alice', botId: 'helper', operation: 'modify', verdict: 'allowed', limit: 1 }
  const input = { operation: 'audit', query }
  const before = await readFile(file, 'utf8')
  assert.equal((await call(dsh, input, { cookie: employeeCookie })).status, 401)
  assert.equal((await call(dsh, input, { site: 'https://foreign.invalid' })).status, 403)
  for (const bad of [{ limit: 101 }, { offset: -1 }, { operation: 'delete' }, { verdict: 'unknown' }, { path: '/hidden' }]) {
    assert.equal((await call(dsh, { ...input, query: { ...query, ...bad } })).status, 400)
  }
  assert.equal(await readFile(file, 'utf8'), before)
  const first = await call(dsh, input)
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await first.json(), { events: [authorization], nextOffset: 1 })
  assert.deepEqual(await (await call(dsh, { ...input, query: { ...query, offset: 1 } })).json(), { events: [effect], nextOffset: null })
  assert.deepEqual(await (await call(dsh, { ...input, query: { personId: 'absent' } })).json(), { events: [], nextOffset: null })
  const views = JSON.parse(await readFile(file, 'utf8')).events.slice(6)
  assert.deepEqual(views.map(({ type, personId, botId }) => [type, personId, botId]), [
    ['audit-view', 'alice', 'helper'], ['audit-view', 'alice', 'helper'], ['audit-view', 'absent', null],
  ])
  assert.equal(new Set(views.map(({ ownerRequestId }) => ownerRequestId)).size, 3)
  assert.ok(views.every(({ time }) => Number.isSafeInteger(time) && time <= Date.now()))
  await auditStore.close()
  const reopened = await openFileAuditStore(file)
  try {
    assert.deepEqual(await reopened.readAudit(query, 'fixture-reopen', () => true), { events: [authorization], nextOffset: 1 })
  } finally { await reopened.close() }
})

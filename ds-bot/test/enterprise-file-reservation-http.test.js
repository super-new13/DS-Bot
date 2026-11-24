import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFileReservationHttpHandler } from '../src/host/enterprise/file-reservation-http.js'
import { openFileReservationStore } from '../src/host/enterprise/file-reservation-store.js'
import { createFileReservations } from '../src/host/enterprise/file-reservations.js'

const origin = 'https://center.example.test'
const peer = Object.freeze({})
const foreignPeer = Object.freeze({})
const scope = { nodeId: 'node', personId: 'alice', botId: 'bot', roomId: 'room',
  sessionId: 'session', requestId: 'request', dispatchId: 'call', operation: 'modify',
  targetId: 'note', version: 'original', contentDigest: 'a'.repeat(64), ruleId: 'write', ruleVersion: 'one',
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsbot-reservation-http-'))
  const store = await openFileReservationStore(join(dir, 'reservations.json'), { initialize: true })
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  const reservations = createFileReservations({ transact: store.transact, canReserve: () => true })
  const proof = new Map()
  const checks = []
  let connected = true
  let verify
  const handle = createFileReservationHttpHandler({ origin, reservations, maxBodyBytes: 2048,
    authenticateWorker: meta => !connected ? undefined : meta === peer ? 'node' : meta === foreignPeer ? 'other' : undefined,
    authorizeScope: (_node, _action, input) => connected && ['personId', 'botId', 'roomId', 'sessionId'].every(key => input[key] === scope[key]),
    async verifySettlement(nodeId, evidence, { signal }) {
      checks.push(evidence)
      if (verify) return verify(signal)
      const saved = proof.get(evidence.evidenceId)
      return saved?.status === evidence.status && saved.scope.nodeId === nodeId
        && Object.keys(scope).every(key => saved.scope[key] === evidence.scope[key])
    },
  })
  const call = (action, payload, options = {}) => {
    const body = JSON.stringify(payload)
    const headers = { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), ...options.headers }
    return handle(new Request(origin + '/internal/enterprise/file-reservations/' + action, {
      method: 'POST', body, headers, signal: options.signal,
    }), Object.hasOwn(options, 'peer') ? options.peer : peer)
  }
  return { call, reservations, proof, checks, connect: value => { connected = value }, replaceVerifier: fn => { verify = fn } }
}

const posix = { skip: process.platform === 'win32' }

function settlement(overrides = {}) {
  return { scope, status: 'completed', evidenceId: 'effect-a', ...overrides }
}

test('only an authenticated worker in the exact scope can reserve or retrieve a permit', posix, async t => {
  const { call, reservations, checks } = await fixture(t)
  assert.equal((await call('reserve', { scope }, { peer: undefined, headers: { 'X-Worker-Node': 'node' } })).status, 403)
  assert.equal((await call('reserve', { scope }, { peer: foreignPeer })).status, 403)
  assert.equal((await call('reserve', { scope: { ...scope, personId: 'bob' } })).status, 403)
  const result = await call('reserve', { scope })
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { issued: true, status: 'reserved' })
  assert.equal(await reservations.revoke('alice'), 'pending')
  assert.deepEqual(await (await call('reserve', { scope })).json(), { issued: false, status: 'reserved' })
  assert.equal((await call('reserve', { scope: { ...scope, dispatchId: 'new' } })).status, 403)
  assert.equal((await call('reserve', { scope: { ...scope, targetId: 'different' } })).status, 403)
  assert.equal((await call('settle', settlement(), { peer: foreignPeer })).status, 403)
  assert.equal((await call('settle', settlement({ scope: { ...scope, roomId: 'other' } }))).status, 403)
  assert.deepEqual(checks, [])
})

test('disconnected or unverified settlements keep revocation pending until terminal proof', posix, async t => {
  const { call, reservations, proof, connect } = await fixture(t)
  assert.equal((await call('reserve', { scope })).status, 200)
  assert.equal(await reservations.revoke('alice'), 'pending')
  assert.equal((await call('settle', settlement({ status: 'unknown' }))).status, 400)
  assert.equal((await call('settle', settlement())).status, 403)
  proof.set('effect-a', { scope: { ...scope, targetId: 'other' }, status: 'completed' })
  assert.equal((await call('settle', settlement())).status, 403)
  proof.set('effect-a', { scope, status: 'completed' })
  connect(false)
  assert.equal((await call('settle', settlement())).status, 403)
  assert.equal(await reservations.revoke('alice'), 'pending')
  connect(true)
  const result = await call('settle', settlement())
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { revocation: 'revoked' })
  assert.deepEqual(await (await call('reserve', { scope })).json(), { issued: false, status: 'completed' })
})

test('abort during evidence verification leaves the reservation pending', posix, async t => {
  const { call, reservations, replaceVerifier } = await fixture(t)
  await call('reserve', { scope })
  await reservations.revoke('alice')
  const controller = new AbortController()
  replaceVerifier(() => { controller.abort(); return true })
  assert.equal((await call('settle', settlement(), { signal: controller.signal })).status, 403)
  assert.equal(await reservations.revoke('alice'), 'pending')
})

test('rejects extra data, malformed scope and oversized metadata before reservation', posix, async t => {
  const { call } = await fixture(t)
  assert.equal((await call('reserve', { scope, bytes: 'fixture bytes' })).status, 400)
  assert.equal((await call('reserve', { scope: { ...scope, version: null } })).status, 400)
  assert.equal((await call('reserve', { scope }, { headers: { 'Content-Length': '2049' } })).status, 413)
  assert.equal((await call('reserve', { scope, extra: 'x'.repeat(2048) }, { headers: { 'Content-Length': '0' } })).status, 413)
  assert.equal((await call('reserve', { scope }, { headers: { 'Content-Length': 'd' } })).status, 400)
  assert.equal((await call('reserve', { scope }, { headers: { 'Content-Type': 'text/plain' } })).status, 415)
  assert.equal((await call('revoke', { scope })).status, 404)
  assert.deepEqual(await (await call('reserve', { scope })).json(), { issued: true, status: 'reserved' })
})

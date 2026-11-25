import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { createOwnerAdmission } from '../src/host/enterprise/owner-auth.js'

const origin = 'https://owner.invalid'

function fixture(options) {
  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const admission = createOwnerAdmission({ origin, tokenHash, ...options })
  const request = { authorization: 'Bearer ' + token, requestOrigin: origin, clientKey: '127.0.0.1' }
  return { admission, request }
}

test('only a same-origin bearer request obtains the owner context', () => {
  assert.throws(() => createOwnerAdmission({ origin }), /Invalid enterprise owner admission configuration/)
  const { admission, request } = fixture()
  assert.equal(admission.admit({ ...request, requestOrigin: 'https://other.invalid' }).status, 403)
  assert.equal(admission.admit({ ...request, fetchSite: 'cross-site' }).status, 403)
  assert.equal(admission.admit({ ...request, authorization: undefined, cookie: 'employee=fixture' }).status, 401)
  assert.equal(admission.admit({ ...request, authorization: [request.authorization] }).status, 401)
  assert.equal(admission.admit({ ...request, authorization: 'Bearer ' + randomBytes(32).toString('base64url') }).status, 401)
  const accepted = admission.admit(request)
  assert.ok(admission.isOwner(accepted.context))
  assert.equal(admission.isOwner({ role: 'owner' }), false)
  assert.ok(!JSON.stringify(accepted).includes(request.authorization))
})

test('failed attempts consume the same bounded per-peer and global budgets', () => {
  let time = 0
  const { admission, request } = fixture({ now: () => time, clientLimit: 1, globalLimit: 2 })
  assert.equal(admission.admit({ ...request, authorization: undefined }).status, 401)
  assert.deepEqual(admission.admit(request), { status: 429, retryAfter: 60 })
  assert.ok(admission.isOwner(admission.admit({ ...request, clientKey: '127.0.0.2' }).context))
  assert.equal(admission.admit({ ...request, clientKey: '127.0.0.3' }).status, 429)
  time = 60_000
  assert.ok(admission.isOwner(admission.admit(request).context))
})

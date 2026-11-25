import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectRoomOpening } from '../src/host/room-opening.js'

const [alpha, admin, beta] = ['alpha', 'admin', 'beta'].map(id => Object.freeze({ id }))
const members = Object.freeze([alpha, admin, beta])
const room = { members, mode: 'admin', adminId: admin.id }
const mentions = (found = [], all = false) => () => ({ found, all })
const silent = { speakers: [], ordered: false }

function select(opener = {}, options = {}, resolve = mentions()) {
  return selectRoomOpening({ ...room, ...options, opener }, resolve)
}

test('plain messages use the admin or the existing roster order', () => {
  assert.deepEqual(select(), { speakers: [admin], ordered: false })
  assert.deepEqual(select({}, { adminId: undefined }), { speakers: members, ordered: true })
  assert.deepEqual(select({}, { mode: 'all' }), { speakers: [admin, alpha, beta], ordered: true })
  assert.deepEqual(select({ botId: admin.id }), { speakers: [alpha, beta], ordered: true })
  assert.deepEqual(select({}, { members: [alpha] }), { speakers: [alpha], ordered: false })
})

test('named and all mentions preserve parallel delivery and exclude the sender', () => {
  assert.deepEqual(select({ botId: alpha.id }, {}, mentions([beta, alpha, admin])), { speakers: [beta, admin], ordered: false })
  assert.deepEqual(select({}, {}, mentions([beta], true)), { speakers: [admin, alpha, beta], ordered: false })
  assert.deepEqual(select({ botId: admin.id }, {}, mentions([], true)), { speakers: [alpha, beta], ordered: false })
})

test('kickoff, quiet, completion and goal openings skip mention resolution', () => {
  const unexpected = () => assert.fail('special opening resolved mentions')
  assert.deepEqual(select({ kickoff: true }, {}, unexpected), { speakers: [admin], ordered: false })
  assert.deepEqual(select({ kickoff: true, botId: admin.id }, {}, unexpected), silent)
  assert.deepEqual(select({ quiet: true, goal: {} }, {}, unexpected), silent)
  assert.deepEqual(select({ done: true, askedBy: beta.id }, {}, unexpected), { speakers: [beta], ordered: false })
  assert.deepEqual(select({ done: true, botId: beta.id, askedBy: beta.id }, {}, unexpected), silent)
  assert.deepEqual(select({ goal: {} }, {}, unexpected), { speakers: [admin], ordered: false })
})

test('progress and non-admin posts call named members and late replies fall back to the caller', () => {
  assert.deepEqual(select({ member: true }, {}, mentions([], true)), silent)
  assert.deepEqual(select({ member: true }, {}, mentions([beta], true)), { speakers: [beta], ordered: false })
  assert.deepEqual(select({ progress: true, askedBy: alpha.id }, {}, mentions([], true)), silent)
  assert.deepEqual(select({ progress: true }, {}, mentions([beta])), { speakers: [beta], ordered: false })
  assert.deepEqual(select({ late: true, askedBy: alpha.id }), { speakers: [alpha], ordered: false })
  assert.deepEqual(select({ late: true, askedBy: alpha.id }, {}, mentions([beta])), { speakers: [beta], ordered: false })
  assert.deepEqual(select({ late: true }), silent)
})

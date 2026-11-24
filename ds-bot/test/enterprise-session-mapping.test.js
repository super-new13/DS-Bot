import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openWorkerSessionMapping } from '../src/host/enterprise/session-mapping.js'

const alice = { nodeId: 'node-a', personId: 'alice', botId: 'bot-a', sessionId: 'session-a' }
const rejected = { code: 'not-authorized' }
const invalid = { code: 'invalid-session-mapping' }

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsbot-session-mapping-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { dir, file: join(dir, 'mapping.json') }
}

test('persists exact ownership and isolates employee, Bot and node scopes across reopening', async t => {
  const { file } = await fixture(t)
  await assert.rejects(openWorkerSessionMapping(file), { code: 'ENOENT' })
  const mapping = await openWorkerSessionMapping(file, { initialize: true })
  const bound = await mapping.bind(alice)
  assert.ok(Object.isFrozen(bound))
  const reopened = await openWorkerSessionMapping(file)
  assert.deepEqual(await reopened.lookup(alice), alice)
  assert.equal(await reopened.owns(alice), true)
  for (const scope of [{ ...alice, personId: 'bob' }, { ...alice, botId: 'bot-b' }, { ...alice, nodeId: 'node-b' }]) {
    assert.equal(await reopened.lookup(scope), undefined)
    assert.equal(await reopened.owns(scope), false)
  }
  assert.equal(await reopened.owns({ ...alice, sessionId: 'unbound' }), false)
  const bob = { ...alice, personId: 'bob', sessionId: 'session-b' }
  const otherNode = { ...alice, nodeId: 'node-b' }
  await reopened.bind(bob)
  await reopened.bind(otherNode)
  assert.deepEqual(await reopened.lookup(bob), bob)
  assert.deepEqual(await reopened.lookup(otherNode), otherNode)
  assert.deepEqual(await reopened.lookup(alice), alice)
})

test('serializes concurrent bindings and refuses reassignment in either direction', async t => {
  const { dir, file } = await fixture(t)
  const mapping = await openWorkerSessionMapping(file, { initialize: true })
  const first = mapping.bind(alice)
  const duplicate = mapping.bind({ ...alice })
  const differentNative = assert.rejects(mapping.bind({ ...alice, sessionId: 'session-b' }), rejected)
  const differentEmployee = assert.rejects(mapping.bind({ ...alice, personId: 'bob' }), rejected)
  const differentBot = assert.rejects(mapping.bind({ ...alice, botId: 'bot-b' }), rejected)
  assert.deepEqual(await Promise.all([first, duplicate]), [alice, alice])
  await Promise.all([differentNative, differentEmployee, differentBot])
  assert.equal(await mapping.owns(alice), true)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).bindings, [alice])
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.deepEqual(await readdir(dir), ['mapping.json'])
})

test('refuses malformed or ambiguous state without replacing it', async t => {
  const { file } = await fixture(t)
  const mapping = await openWorkerSessionMapping(file, { initialize: true })
  const malformed = [
    '{"version":',
    JSON.stringify({ version: 2, bindings: [] }),
    ...[
      [{ ...alice, sessionId: null }],
      [alice, { ...alice, personId: 'bob' }],
      [alice, { ...alice, sessionId: 'session-b' }],
    ].map(bindings => JSON.stringify({ version: 1, bindings })),
  ]
  for (const text of malformed) {
    await writeFile(file, text)
    await assert.rejects(mapping.lookup(alice), invalid)
    await assert.rejects(mapping.bind(alice), invalid)
    await assert.rejects(openWorkerSessionMapping(file, { initialize: true }), invalid)
    assert.equal(await readFile(file, 'utf8'), text)
  }
})

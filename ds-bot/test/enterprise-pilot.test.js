import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { startEmployeeRuntime } from '../src/host/enterprise/employee-runtime.js'
import { createRemoteWorkerAdapter } from '../src/host/enterprise/remote-adapter.js'
import { createWorkerClient } from '../src/host/enterprise/worker-client.js'
import { startLocalWorkerRuntime } from '../src/host/enterprise/worker-runtime.js'
import { createWorkerTlsTransport } from '../src/host/enterprise/worker-tls.js'

function makeTls(dir) {
  const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, timeout: 5000, stdio: 'ignore' })
  openssl('req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '1', '-subj', '/CN=Runtime fixture CA',
    '-keyout', 'ca.key', '-out', 'ca.pem')
  const ca = readFileSync(join(dir, 'ca.pem'))
  function issue(name, extensions) {
    openssl('req', '-new', '-nodes', '-newkey', 'rsa:2048', '-subj', '/CN=' + name,
      '-keyout', name + '.key', '-out', name + '.csr')
    writeFileSync(join(dir, name + '.ext'), extensions.join(String.fromCharCode(10)))
    openssl('x509', '-req', '-in', name + '.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-days', '1', '-extfile', name + '.ext', '-out', name + '.pem')
    return { ca, key: readFileSync(join(dir, name + '.key')), cert: readFileSync(join(dir, name + '.pem')) }
  }
  return { server: issue('server', ['extendedKeyUsage=serverAuth', 'subjectAltName=IP:127.0.0.1']),
    controller: issue('controller', ['extendedKeyUsage=clientAuth']) }
}

async function mockContext(calls) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  class Model extends LlmAdapter {
    providerInfo() { return { id: 'mock', name: 'Mock' } }
    async resolveModel(provider, id) {
      return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 }, defaultMaxTokens: 1000 }
    }
    async *stream({ messages, signal }) {
      const prompt = messages.findLast(message => message.role === 'user').content[0].text
      calls.push(prompt)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      const text = 'reply to ' + prompt
      yield { type: 'text-delta', index: 0, text }
      if (prompt.startsWith('hold ')) {
        const hold = Promise.withResolvers()
        const listener = addAbortListener(signal, hold.resolve)
        try { await hold.promise } finally { listener[Symbol.dispose]() }
        signal.throwIfAborted()
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['mock'], new Model())
  await mountAgentLoopTestHarness(ctx)
  return ctx
}

const host = '127.0.0.1'
const origin = 'https://' + host
const auth = '/api/enterprise/auth/'
const chat = '/api/enterprise/private-chat/'
const password = 'disposable pilot password'

async function post(runtime, ca, path, json, cookie) {
  const body = JSON.stringify(json)
  const response = await new Promise((resolve, reject) => {
    const req = httpsRequest({ host, port: runtime.address.port, path, ca, agent: false, method: 'POST',
      signal: AbortSignal.timeout(6000), headers: { host, origin, ...(cookie ? { cookie } : {}),
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      },
    }, resolve)
    req.once('error', reject)
    req.end(body)
  })
  assert.equal(response.socket.authorized, true)
  return response
}

async function* frames(response) {
  assert.equal(response.statusCode, 200)
  assert.match(response.headers['content-type'], /^text[/]event-stream/)
  const separator = String.fromCharCode(10).repeat(2)
  let buffer = ''
  for await (const chunk of response.setEncoding('utf8')) {
    buffer += chunk
    let end
    while ((end = buffer.indexOf(separator)) !== -1) {
      const frame = buffer.slice(0, end)
      buffer = buffer.slice(end + separator.length)
      assert.ok(frame.startsWith('data: '))
      yield JSON.parse(frame.slice(6))
    }
  }
  assert.equal(buffer, '')
}

test('employee HTTPS pilot isolates remote streams and preserves uncertain receipts without replay', { timeout: 12000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-enterprise-pilot-'))
  const instances = []
  t.after(async () => {
    try { await Promise.all(instances.map(instance => instance.close())) }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
  const tls = makeTls(dir)
  const fingerprint = new X509Certificate(tls.controller.cert).fingerprint256
  const calls = []
  const submissions = []
  const nodeId = 'mock-node'
  const botId = 'helper'
  const roster = {
    people: {
      alice: { id: 'alice', name: 'Alice', botIds: [botId] },
      bob: { id: 'bob', name: 'Bob', botIds: [botId] },
    },
    bots: { helper: { id: botId, nodeId } }, rooms: {},
  }
  const owns = scope => scope.nodeId === nodeId && scope.botId === botId && Object.hasOwn(roster.people, scope.personId)
  async function startWorker(initialize) {
    const instance = await startLocalWorkerRuntime({
      ctx: await mockContext(calls), nodeId, provider: 'mock', model: 'model', initialize,
      receiptPath: join(dir, 'receipts.json'), tls: tls.server,
      authorizeSession: owns,
      authorizePeer: (peer, { scope }) => peer === fingerprint && owns(scope),
    })
    instances.push(instance)
    const transport = createWorkerTlsTransport({ ...tls.controller, origin: instance.origin })
    const client = createWorkerClient({ origin: instance.origin, nodeId, async transport(request) {
      if (new URL(request.url).pathname.endsWith('/submit')) submissions.push(await request.clone().json())
      return transport(request)
    } })
    return { instance, client }
  }
  const worker = await startWorker(true)
  const employee = await startEmployeeRuntime({
    accountFile: join(dir, 'accounts.json'), initializeAccounts: true, readConfig: () => roster,
    workers: new Map([[nodeId, createRemoteWorkerAdapter({ client: worker.client, nodeId })]]),
    limits: { maxActive: 2, maxPerBot: 2, maxPerNode: 2, maxPending: 2 },
    readHistory: () => undefined, enqueueGroup: () => false,
    https: { origin, tls: tls.server },
  })
  instances.push(employee)
  const send = (path, body, cookie) => post(employee, tls.server.ca, path, body, cookie)
  async function login(personId) {
    const { token } = await employee.accounts.issueInvite(personId)
    const redeem = await send(auth + 'redeem', { token, password })
    assert.equal(redeem.statusCode, 204)
    redeem.resume()
    const response = await send(auth + 'login', { personId, password })
    assert.equal(response.statusCode, 204)
    response.resume()
    return response.headers['set-cookie'][0].split(';', 1)[0]
  }
  async function startChat(cookie, text) {
    const stream = frames(await send(chat + 'send', { botId, text }, cookie))
    const { value: queued } = await stream.next()
    assert.equal(queued?.type, 'queued')
    return { stream, requestId: queued.requestId }
  }
  async function cancel(cookie, requestId, status) {
    const result = await send(chat + 'cancel', { botId, requestId }, cookie)
    result.resume()
    assert.equal(result.statusCode, status)
  }
  async function nextFrame(turn, fields) {
    assert.deepEqual((await turn.stream.next()).value, { ...fields, requestId: turn.requestId })
  }
  const alice = await login('alice')
  const bob = await login('bob')
  const first = await startChat(alice, 'hold Alice')
  await nextFrame(first, { type: 'delta', text: 'reply to hold Alice' })
  const second = await startChat(bob, 'Bob')
  await nextFrame(second, { type: 'delta', text: 'reply to Bob' })
  await nextFrame(second, { type: 'reply', text: 'reply to Bob' })
  await nextFrame(second, { type: 'done', status: 'completed' })
  assert.equal((await second.stream.next()).done, true)
  assert.notEqual(submissions[0].sessionId, submissions[1].sessionId)
  assert.deepEqual(submissions.map(item => item.personId), ['alice', 'bob'])
  await cancel(bob, first.requestId, 403)
  await cancel(alice, first.requestId, 202)
  await nextFrame(first, { type: 'done', status: 'aborted' })
  assert.equal((await first.stream.next()).done, true)

  const interrupted = await startChat(alice, 'hold interrupted')
  await nextFrame(interrupted, { type: 'delta', text: 'reply to hold interrupted' })
  await cancel(alice, first.requestId, 403)
  const { requestId, text, ...oldScope } = submissions.find(item => item.requestId === interrupted.requestId)
  assert.equal((await worker.client.status(oldScope, requestId)).status, 'admitted')
  await worker.instance.close()
  await nextFrame(interrupted, { type: 'error', code: 'worker-outcome-unknown' })
  assert.equal((await interrupted.stream.next()).done, true)
  assert.equal(submissions.length, 3)

  const restarted = await startWorker(false)
  const receipt = await restarted.client.status(oldScope, requestId)
  assert.equal(receipt.status, 'unknown')
  assert.ok(Number.isSafeInteger(receipt.admittedAt))
  assert.deepEqual(await restarted.client.status({ ...oldScope, personId: 'bob' }, requestId), { requestId, status: 'unknown' })
  assert.deepEqual(await restarted.client.submit(oldScope, requestId, text), receipt)
  assert.deepEqual(calls, ['hold Alice', 'Bob', 'hold interrupted'])
})

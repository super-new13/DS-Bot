import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEmployeeApi, EnterpriseApiError } from '../src/client/enterprise/api.js'

const requestId = 'request-1'
const queued = { type: 'queued', requestId }
const done = { type: 'done', requestId, status: 'completed' }
const frame = value => 'data: ' + JSON.stringify(value) + '\n\n'
const encoder = new TextEncoder()
const eventResponse = body => new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
const clientFor = (response, options) => createEmployeeApi({ ...options, fetch: async () => response })

function chunks(text) {
  const bytes = encoder.encode(text)
  let index = 0
  return new ReadableStream({ pull(controller) {
    if (index === bytes.length) controller.close()
    else controller.enqueue(bytes.subarray(index, ++index))
  } })
}

test('uses credentialed same-origin Fetch for auth, group history and send, and private cancel', async () => {
  const calls = []
  let signedIn = false
  const api = createEmployeeApi({ fetch: async (url, init) => {
    assert.match(url, /^\/api\/enterprise\//)
    assert.equal(init.mode, 'same-origin')
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store')
    calls.push([url, init.method, init.body && JSON.parse(init.body)])
    if (url.endsWith('/login')) signedIn = true
    if (url.endsWith('/logout')) signedIn = false
    if (url.endsWith('/session')) return signedIn ? Response.json({ personId: 'alice' }) : Response.json({ error: 'Invalid credentials' }, { status: 401 })
    if (url.endsWith('/history')) return Response.json({ roomId: 'general', messages: [{ kind: 'user', text: 'Hello', by: 'alice' }] })
    if (url.endsWith('/send')) return Response.json({ requestId }, { status: 202 })
    if (url.endsWith('/cancel')) return Response.json({ accepted: true }, { status: 202 })
    return new Response(null, { status: 204 })
  } })
  assert.equal(await api.currentSession(), null)
  await api.redeemInvite('mock invite', 'mock password')
  await api.login('alice', 'mock password')
  assert.deepEqual(await api.currentSession(), { personId: 'alice' })
  assert.deepEqual(await api.groupHistory('general'), { roomId: 'general', messages: [{ kind: 'user', text: 'Hello', by: 'alice' }] })
  assert.deepEqual(await api.sendGroup('general', 'Hello'), { requestId })
  assert.deepEqual(await api.cancelPrivate('bot', requestId), { accepted: true })
  await api.logout()
  assert.equal(await api.currentSession(), null)
  await assert.rejects(api.groupHistory('../auth/session'), { code: 'invalid-room' })
  assert.deepEqual(calls, [
    ['/api/enterprise/auth/session', 'GET', undefined],
    ['/api/enterprise/auth/redeem', 'POST', { token: 'mock invite', password: 'mock password' }],
    ['/api/enterprise/auth/login', 'POST', { personId: 'alice', password: 'mock password' }],
    ['/api/enterprise/auth/session', 'GET', undefined],
    ['/api/enterprise/group-chat/general/history', 'GET', undefined],
    ['/api/enterprise/group-chat/general/send', 'POST', { text: 'Hello' }],
    ['/api/enterprise/private-chat/cancel', 'POST', { botId: 'bot', requestId }],
    ['/api/enterprise/auth/logout', 'POST', undefined],
    ['/api/enterprise/auth/session', 'GET', undefined],
  ])
})

test('parses UTF-8 split at every byte, SSE line endings, comments and multiline data', async () => {
  const wire = '\uFEFF: heartbeat\r\n\r\n' + frame(queued).replaceAll('\n', '\r\n')
    + 'data: {"type":"delta",\rdata: "requestId":"request-1","text":"你好 👋"}\r\r'
    + frame({ type: 'reply', requestId, text: 'Café' }) + frame(done)
  const events = []
  const api = createEmployeeApi({ fetch: async (url, init) => {
    assert.equal(url, '/api/enterprise/private-chat/send')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers.Accept, 'text/event-stream')
    assert.deepEqual(JSON.parse(init.body), { botId: 'bot', text: 'Hello' })
    return eventResponse(chunks(wire))
  } })
  assert.deepEqual(await api.sendPrivate('bot', 'Hello', { onEvent: event => events.push(event) }), done)
  assert.deepEqual(events, [queued, { type: 'delta', requestId, text: '你好 👋' }, { type: 'reply', requestId, text: 'Café' }, done])
})

test('distinguishes terminal outcomes from incomplete streams without retrying', async () => {
  for (const terminal of [done, { ...done, status: 'aborted' }, { ...done, status: 'failed' }, { type: 'error', requestId, code: 'queue-full' }]) {
    const api = clientFor(eventResponse(frame(queued) + frame(terminal)))
    assert.deepEqual(await api.sendPrivate('bot', 'Hello'), terminal)
  }
  for (const wire of [frame(queued), frame(queued) + frame(done).slice(0, -1)]) {
    let calls = 0
    const api = createEmployeeApi({ fetch: async () => { calls++; return eventResponse(wire) } })
    await assert.rejects(api.sendPrivate('bot', 'Hello'), { code: 'incomplete-stream', requestId })
    assert.equal(calls, 1)
  }
  const broken = clientFor(eventResponse(new ReadableStream({ start(controller) { controller.error(new Error('socket lost')) } })))
  await assert.rejects(broken.sendPrivate('bot', 'Hello'), { code: 'incomplete-stream' })
})

test('enforces frame and total caps and rejects malformed or unscoped frames', async () => {
  const oversized = clientFor(eventResponse(frame(queued) + 'data: ' + 'x'.repeat(128)), { maxFrameBytes: 100 })
  await assert.rejects(oversized.sendPrivate('bot', 'Hello'), { code: 'frame-too-large', requestId })
  const overStream = clientFor(eventResponse(frame(queued) + ': keepalive\n\n'.repeat(10) + frame(done)), { maxStreamBytes: 100 })
  await assert.rejects(overStream.sendPrivate('bot', 'Hello'), { code: 'stream-too-large', requestId })
  const malformed = [frame(done), frame(queued) + frame({ ...done, requestId: 'other' }), frame(queued) + 'data: {\n\n']
  for (const wire of malformed) {
    await assert.rejects(clientFor(eventResponse(wire)).sendPrivate('bot', 'Hello'), { code: 'invalid-stream' })
  }
  await assert.rejects(clientFor(eventResponse(Uint8Array.of(255, 10))).sendPrivate('bot', 'Hello'), { code: 'invalid-stream' })
  await assert.rejects(clientFor(new Response('html')).sendPrivate('bot', 'Hello'), { code: 'invalid-stream' })
})

test('logout cancels an open private stream after the server acknowledges it', async () => {
  const seen = Promise.withResolvers()
  const cancelled = Promise.withResolvers()
  const api = createEmployeeApi({ fetch: async (url, init) => {
    if (url.endsWith('/logout')) return new Response(null, { status: 204 })
    assert.equal(init.signal.aborted, false)
    return eventResponse(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(frame(queued))) },
      cancel() { cancelled.resolve() },
    }))
  } })
  const chat = api.sendPrivate('bot', 'Hello', { onEvent: event => { assert.deepEqual(event, queued); seen.resolve() } })
  const stopped = assert.rejects(chat, { code: 'aborted', requestId })
  await seen.promise
  await api.logout()
  await Promise.all([stopped, cancelled.promise])
})

test('HTTP errors are typed and do not expose server response bodies', async () => {
  const api = clientFor(Response.json({ error: 'fixture internal detail' }, { status: 429 }))
  await assert.rejects(api.login('alice', 'mock password'), error => error instanceof EnterpriseApiError
    && error.code === 'http-error' && error.status === 429 && !error.message.includes('fixture internal detail'))
})

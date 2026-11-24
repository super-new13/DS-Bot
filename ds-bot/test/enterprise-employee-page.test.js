import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createEmployeeGroupChatHandler } from '../src/host/enterprise/group-chat-http.js'
import { chromium } from 'playwright-core'

const executablePath = process.env.EMPLOYEE_PAGE_CHROMIUM || chromium.executablePath()
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/page.css', ['page.css', 'text/css']],
  ['/page.js', ['page.js', 'text/javascript']],
  ['/api.js', ['api.js', 'text/javascript']],
])
const password = 'fixture-password'
const literal = '<img src="/unexpected">'
const frame = (type, fields = {}) => 'data: ' + JSON.stringify({ type, requestId: 'mock-turn', ...fields }) + '\n\n'

test('employee pilot activates, signs in, streams and clears scoped text', {
  skip: !existsSync(executablePath) && 'Install Chromium or set EMPLOYEE_PAGE_CHROMIUM', timeout: 30_000,
}, async t => {
  const alice = 'mock-employee'
  const bob = 'mock-bob'
  const tokens = new Map([['a'.repeat(43), alice], ['b'.repeat(43), bob]])
  const roster = {
    people: { [alice]: { id: alice, name: 'Alice' }, [bob]: { id: bob, name: 'Bob' } },
    rooms: { design: { id: 'design', people: [alice] }, operations: { id: 'operations', people: [bob] }, shared: { id: 'shared', people: [alice, bob] } },
  }
  const rows = { design: [{ roomId: 'design', kind: 'bot', name: 'Helper', text: literal }], operations: [], shared: [] }
  let roomHandler
  let activated = false
  let loggedIn = false
  let pending
  let sent = 0
  let cancels = 0
  let logoutCalls = 0
  const serverErrors = []
  const server = createServer(async (req, res) => {
    try {
      const asset = assets.get(req.url)
      if (asset && req.method === 'GET') {
        const content = await readFile(new URL('../src/client/enterprise/' + asset[0], import.meta.url))
        return res.writeHead(200, { 'Content-Type': asset[1] }).end(content)
      }
      if (req.url === '/favicon.ico') return res.writeHead(404).end()
      const reply = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : undefined
      const token = req.headers.cookie?.split('=', 2)[1]
      if (req.url.startsWith('/api/enterprise/group-chat/')) {
        const request = new Request(origin + req.url, { method: req.method, headers: { ...req.headers, ...(token && { cookie: '__Host-dsbot-employee=' + token }), ...(req.headers.origin === origin.replace('https:', 'http:') && { origin }) }, body: raw || undefined })
        const response = await roomHandler(request)
        return res.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text())
      }
      switch (req.method + ' ' + req.url) {
        case 'GET /api/enterprise/auth/session':
          return tokens.has(token) && (loggedIn || tokens.get(token) === bob) ? reply(200, { personId: tokens.get(token) }) : reply(401)
        case 'POST /api/enterprise/auth/redeem':
          if (activated || body.token !== 'fixture-invite') return reply(401)
          assert.deepEqual(body, { token: 'fixture-invite', password })
          activated = true
          return reply(204)
        case 'POST /api/enterprise/auth/login':
          if (!activated || body.password !== password) return reply(401)
          assert.deepEqual(body, { personId: 'mock-employee', password })
          loggedIn = true
          res.setHeader('Set-Cookie', 'fixture-employee=' + 'a'.repeat(43) + '; Path=/; HttpOnly')
          return reply(204)
        case 'POST /api/enterprise/auth/logout':
          if (++logoutCalls === 1) return reply(503)
          loggedIn = false
          return reply(204)
        case 'POST /api/enterprise/private-chat/send':
          if (!loggedIn) return reply(401)
          assert.equal(body.botId, 'fixture-bot')
          sent++
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(frame('queued'))
          if (body.text === 'complete') return res.end(frame('delta', { text: 'draft' }) + frame('reply', { text: literal }) + frame('done', { status: 'completed' }))
          if (body.text === 'disconnect') return res.end()
          pending = res
          return
        case 'POST /api/enterprise/private-chat/cancel':
          assert.deepEqual(body, { botId: 'fixture-bot', requestId: 'mock-turn' })
          cancels++
          pending.end(frame('done', { status: 'aborted' }))
          return reply(202, { accepted: true })
        default:
          throw new Error('Unexpected fixture request: ' + req.method + ' ' + req.url)
      }
    } catch (error) {
      serverErrors.push(error)
      res.destroy()
    }
  })
  server.listen(0, '127.0.0.1')
  t.after(() => { server.closeAllConnections(); server.close() })
  await once(server, 'listening')
  const browser = await chromium.launch({ executablePath })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', reducedMotion: 'reduce' })
  page.setDefaultTimeout(4000)
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error))
  const origin = 'https://127.0.0.1:' + server.address().port
  roomHandler = createEmployeeGroupChatHandler({ origin, readRoster: () => roster,
    accounts: { resolveSession(token) { return tokens.has(token) ? { personId: tokens.get(token), loginSessionId: token } : undefined },
      isSessionActive: ({ personId, loginSessionId }) => tokens.get(loginSessionId) === personId },
    readHistory: ({ roomId }) => ({ roomId, messages: rows[roomId] }),
    enqueue(_, dispatch) {
      void dispatch(({ roomId, text, source }) => rows[roomId].push({ roomId, kind: 'user', text, ...source })).catch(error => serverErrors.push(error))
      return true
    },
  })
  const url = 'http://127.0.0.1:' + server.address().port + '/'
  await page.goto(url)
  const button = name => page.getByRole('button', { name, exact: true })
  const visibleText = text => page.getByText(text, { exact: true }).waitFor({ state: 'visible' })
  const get = id => page.locator('#' + id)

  await button('Sign in').waitFor()
  assert.equal(await get('chat').isVisible(), false)
  await button('Use an invitation').click()
  await get('invite-token').fill('invalid-fixture-code')
  await get('invite-password').fill(password)
  await button('Activate account').click()
  await visibleText('This invitation could not be used. Check the code or ask your administrator for a new one.')
  assert.equal(await get('invite-token').inputValue(), '')
  await get('invite-token').fill('fixture-invite')
  await get('invite-password').fill(password)
  await button('Activate account').click()
  await visibleText('Account activated. Sign in with your employee ID and new password.')
  await get('person-id').fill('mock-employee')
  await get('login-password').fill('wrong-fixture-password')
  await button('Sign in').click()
  await visibleText('Sign-in failed. Check your employee ID and password.')
  assert.equal(await get('login-password').inputValue(), '')
  await get('login-password').fill(password)
  await get('login-password').press('Enter')
  await visibleText('mock-employee')
  await page.reload()
  await visibleText('mock-employee')
  assert.equal(await get('auth').isVisible(), false)
  await get('bot-id').fill('fixture-bot')
  const send = async text => {
    await get('message').fill(text)
    await button('Send').click()
  }
  await send('complete')
  await visibleText('Reply complete.')
  assert.deepEqual(await page.locator('[data-author="bot"] p').allTextContents(), [literal])
  assert.equal(await page.locator('#messages img').count(), 0)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390)
  await get('room-picker').locator('option[value="design"]').waitFor({ state: 'attached' })
  assert.deepEqual(await get('room-picker').locator('option').allTextContents(), ['Choose a room', 'design', 'shared'])
  if (process.env.EMPLOYEE_PAGE_CAPTURE) await page.screenshot({ path: process.env.EMPLOYEE_PAGE_CAPTURE })

  const other = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', reducedMotion: 'reduce' })
  await other.context().addCookies([{ url, name: 'fixture-employee', value: 'b'.repeat(43), httpOnly: true }])
  await other.goto(url)
  await other.locator('#room-picker option[value="operations"]').waitFor({ state: 'attached' })
  assert.deepEqual(await other.locator('#room-picker option').allTextContents(), ['Choose a room', 'operations', 'shared'])
  await get('room-picker').selectOption('design')
  const roomText = text => get('room-messages').getByText(text, { exact: true })
  await roomText(literal).waitFor()
  assert.equal(await get('room-messages').locator('img').count(), 0)
  if (process.env.EMPLOYEE_ROOM_CAPTURE) await page.screenshot({ path: process.env.EMPLOYEE_ROOM_CAPTURE, fullPage: true })
  await get('room-picker').selectOption('shared')
  await roomText(literal).waitFor({ state: 'detached' })
  await get('room-message').fill('Shared update')
  await button('Send to room').click()
  await roomText('Shared update').waitFor()
  await roomText('Alice').waitFor()
  await other.locator('#room-picker').selectOption('shared')
  await other.locator('#room-messages').getByText('Shared update', { exact: true }).waitFor()
  await other.locator('#room-message').fill('Reply from Bob')
  await other.getByRole('button', { name: 'Send to room' }).click()
  await other.locator('#room-messages').getByText('Bob', { exact: true }).waitFor()
  roster.rooms.shared.people = [bob]
  await page.getByText('Room access was removed.', { exact: true }).waitFor({ timeout: 8000 })
  assert.equal(await get('room-messages').textContent(), '')
  assert.equal(await get('room-compose').isVisible(), false)

  await send('disconnect')
  await visibleText('The chat outcome is unknown. Your message may have been received.')
  await send('stop')
  await visibleText('Queued…')
  assert.equal(await button('Send').isEnabled(), false)
  await button('Stop').click()
  await visibleText('Reply stopped.')
  assert.equal(cancels, 1)

  await send('logout')
  await visibleText('Queued…')
  await button('Sign out').click()
  await visibleText('Could not confirm sign-out. Try signing out again.')
  assert.equal(await get('chat').isVisible(), false)
  assert.equal(await get('messages').textContent(), '')
  assert.equal(await get('auth').isVisible(), false)
  await button('Sign out').click()
  await button('Sign in').waitFor()
  assert.equal(sent, 4)
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(serverErrors, [])
  assert.equal(page.url(), url)
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0])
})

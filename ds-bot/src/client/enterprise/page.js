import { createEmployeeApi } from './api.js'

const api = createEmployeeApi()
const field = id => document.getElementById(id)
const login = field('login')
const invite = field('invite')
const logout = field('logout')
const retry = field('retry-session')
const switchAuth = field('switch-auth')
const employee = field('employee')
const bot = field('bot-id')
const message = field('message')
const messages = field('messages')
const send = field('send')
const stop = field('stop')
let person = null
let run = null
let transcriptBot
let authBusy = false

function feedback(id, text = '', error = false) {
  const node = field(id)
  node.textContent = text
  node.toggleAttribute('data-error', error)
}

function setSession(session) {
  run?.controller.abort()
  run = null
  transcriptBot = undefined
  messages.replaceChildren()
  field('compose').reset()
  field('empty').hidden = false
  feedback('chat-status')
  setSending(false)
  person = session
  employee.hidden = !person
  employee.textContent = person?.personId ?? ''
  field('chat').hidden = !person
  logout.hidden = !person
  field('auth').hidden = Boolean(person)
}

async function checkSession(focus = false) {
  retry.hidden = true
  field('auth').hidden = true
  feedback('session-status', 'Checking your session…')
  try {
    setSession(await api.currentSession())
    feedback('session-status')
    if (focus) field(person ? 'chat-title' : 'person-id').focus()
  } catch {
    feedback('session-status', 'Could not check your session.', true)
    retry.hidden = false
    retry.focus()
  }
}

function showInvite(show) {
  login.reset()
  invite.reset()
  login.hidden = show
  invite.hidden = !show
  field('auth-title').textContent = show ? 'Activate your account' : 'Sign in'
  switchAuth.textContent = show ? 'Back to sign in' : 'Use an invitation'
  feedback('auth-status')
}

switchAuth.addEventListener('click', () => {
  showInvite(invite.hidden)
  field(invite.hidden ? 'person-id' : 'invite-token').focus()
})

function authSubmit(form, submit, failure) {
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (authBusy || form.hidden || field('auth').hidden) return
    authBusy = true
    const submitButton = form.querySelector('button')
    submitButton.disabled = switchAuth.disabled = true
    feedback('auth-status', 'Working…')
    try {
      await submit()
    } catch (error) {
      feedback('auth-status', error.status === 429 ? 'Too many attempts. Wait before trying again.' : error.status === 401 ? failure : 'Could not connect or complete the request. Check your connection and try again.', true)
    } finally {
      authBusy = false
      submitButton.disabled = switchAuth.disabled = false
    }
  })
}

authSubmit(invite, async () => {
  const token = field('invite-token').value.trim()
  const password = field('invite-password').value
  invite.reset()
  await api.redeemInvite(token, password)
  showInvite(false)
  feedback('auth-status', 'Account activated. Sign in with your employee ID and new password.')
  field('person-id').focus()
}, 'This invitation could not be used. Check the code or ask your administrator for a new one.')

authSubmit(login, async () => {
  const personId = field('person-id').value.trim()
  const password = field('login-password').value
  field('login-password').value = ''
  await api.login(personId, password)
  showInvite(false)
  await checkSession(true)
}, 'Sign-in failed. Check your employee ID and password.')

async function signOut() {
  setSession(null)
  field('auth').hidden = true
  logout.hidden = true
  logout.disabled = true
  feedback('session-status', 'Signing out…')
  try {
    await api.logout()
    showInvite(false)
    field('auth').hidden = false
    feedback('session-status')
    field('person-id').focus()
  } catch {
    feedback('session-status', 'Could not confirm sign-out. Try signing out again.', true)
    logout.hidden = false
    logout.focus()
  } finally {
    logout.disabled = false
    if (!logout.hidden) logout.focus()
  }
}

function setSending(sending) {
  bot.readOnly = message.readOnly = send.disabled = sending
  stop.hidden = !run?.requestId
  stop.disabled = Boolean(run?.stopping)
}

function addMessage(author, label, text = '') {
  const bubble = document.createElement('div')
  const name = document.createElement('span')
  const body = document.createElement('p')
  bubble.className = 'message'
  bubble.dataset.author = author
  name.textContent = label
  body.textContent = text
  bubble.append(name, body)
  messages.append(bubble)
  field('empty').hidden = true
  scrollMessages()
  return body
}

function scrollMessages() {
  messages.scrollTop = messages.scrollHeight
}

function sessionEnded() {
  setSession(null)
  feedback('auth-status', 'Your session ended. Sign in again.', true)
  field('person-id').focus()
}

function streamFailure(code) {
  if (code === 'queue-full') return 'The queue is full. Wait before sending another message.'
  if (code === 'not-authorized') return 'Chat access was denied. Check the Bot ID or ask your administrator.'
  if (code === 'unavailable') return 'This Bot is unavailable.'
  return 'The chat outcome is unknown. Your message may have been received.'
}

field('compose').addEventListener('submit', async event => {
  event.preventDefault()
  if (!person || run) return
  const botId = bot.value.trim()
  const text = message.value
  if (!botId || !text.trim()) {
    feedback('chat-status', 'Enter a Bot ID and a message.', true)
    return
  }
  if (transcriptBot !== botId) messages.replaceChildren()
  transcriptBot = botId
  const current = { botId, controller: new AbortController() }
  run = current
  setSending(true)
  message.value = ''
  addMessage('you', 'You', text)
  feedback('chat-status', 'Sending…')
  let reply
  try {
    const result = await api.sendPrivate(botId, text, {
      signal: current.controller.signal,
      onEvent(frame) {
        if (run !== current) return
        if (frame.type === 'queued') {
          current.requestId = frame.requestId
          feedback('chat-status', 'Queued…')
          setSending(true)
        }
        if (frame.type === 'delta' || frame.type === 'reply') {
          reply ??= addMessage('bot', botId)
          if (frame.type === 'delta') reply.append(frame.text)
          else {
            reply.textContent = frame.text
            reply = undefined
          }
          if (!current.stopping) feedback('chat-status', 'Replying…')
          scrollMessages()
        }
      },
    })
    if (run !== current) return
    if (result.type === 'error') {
      if (result.code === 'not-authorized' && !await api.currentSession({ signal: current.controller.signal })) {
        if (run === current) sessionEnded()
      } else if (run === current) feedback('chat-status', streamFailure(result.code), true)
    } else {
      const status = result.status === 'completed' ? 'Reply complete.' : result.status === 'aborted' ? 'Reply stopped.' : 'The Bot could not finish the reply.'
      feedback('chat-status', status, result.status === 'failed')
    }
  } catch (error) {
    if (run !== current) return
    if (error.status === 401) sessionEnded()
    else feedback('chat-status', streamFailure(error.status === 403 ? 'not-authorized' : error.code), true)
  } finally {
    if (run === current) {
      const restoreFocus = document.activeElement === stop || document.activeElement === document.body
      run = null
      setSending(false)
      if (restoreFocus) message.focus()
    }
  }
})

stop.addEventListener('click', async () => {
  const current = run
  if (!current?.requestId || current.stopping) return
  current.stopping = true
  setSending(true)
  feedback('chat-status', 'Requesting stop…')
  try {
    await api.cancelPrivate(current.botId, current.requestId, { signal: current.controller.signal })
    if (run === current) feedback('chat-status', 'Stop requested. Waiting for the Bot…')
  } catch (error) {
    if (run !== current) return
    if (error.status === 401) sessionEnded()
    else {
      current.stopping = false
      setSending(true)
      feedback('chat-status', 'Could not confirm the stop request. Waiting for the chat result.', true)
    }
  }
})

retry.addEventListener('click', () => { void checkSession(true) })
logout.addEventListener('click', signOut)
window.addEventListener('pagehide', () => {
  setSession(null)
  showInvite(false)
  field('auth').hidden = true
})
window.addEventListener('pageshow', event => {
  if (event.persisted) location.reload()
})
void checkSession()

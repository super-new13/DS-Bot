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
const picker = field('room-picker')
const roomMessages = field('room-messages')
const roomCompose = field('room-compose')
let roomLoad
let roomSending = false
let roomTimer

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
  resetRooms()
  field('rooms').hidden = !person
  if (person) void loadRooms()
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

function messageBubble(author, label, text = '') {
  const bubble = document.createElement('div')
  const name = document.createElement('span')
  const body = document.createElement('p')
  bubble.className = 'message'
  bubble.dataset.author = author
  name.textContent = label
  body.textContent = text
  bubble.append(name, body)
  return bubble
}

function addMessage(author, label, text) {
  const bubble = messageBubble(author, label, text)
  messages.append(bubble)
  field('empty').hidden = true
  scrollMessages()
  return bubble.lastElementChild
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

function resetRooms() {
  clearTimeout(roomTimer)
  roomLoad?.abort()
  roomLoad = undefined
  roomSending = false
  picker.replaceChildren(new Option('Choose a room', ''))
  picker.disabled = true
  roomMessages.replaceChildren()
  roomCompose.reset()
  roomCompose.hidden = true
  field('room-send').disabled = false
  feedback('room-status')
}

async function loadRooms({ clear = false } = {}) {
  if (!person || roomSending) return
  clearTimeout(roomTimer)
  roomLoad?.abort()
  const job = new AbortController()
  roomLoad = job
  const signal = AbortSignal.any([job.signal, AbortSignal.timeout(5000)])
  const selected = picker.value
  if (clear) {
    roomMessages.replaceChildren()
    roomCompose.hidden = true
    feedback('room-status', 'Checking room access…')
  }
  try {
    const rooms = await api.listRooms({ signal })
    if (signal.aborted) return
    picker.replaceChildren(new Option('Choose a room', ''), ...rooms.map(({ id }) => new Option(id, id)))
    picker.disabled = rooms.length === 0
    if (!rooms.some(room => room.id === selected)) {
      roomMessages.replaceChildren()
      roomCompose.reset()
      roomCompose.hidden = true
      feedback('room-status', selected ? 'Room access was removed.' : rooms.length ? 'Choose a room to read messages.' : 'No rooms assigned.', Boolean(selected))
      return
    }
    picker.value = selected
    const history = await api.groupHistory(selected, { signal })
    if (signal.aborted) return
    roomMessages.replaceChildren(...history.messages.filter(row => row && typeof row.text === 'string')
      .map(row => messageBubble(row.by === person.personId ? 'you' : 'room', row.name || row.by || (row.kind === 'bot' ? 'Bot' : 'Employee'), row.text)))
    roomCompose.hidden = false
    feedback('room-status', history.messages.length ? '' : 'No messages yet.')
  } catch (error) {
    if (job.signal.aborted) return
    if (error.status === 401) return sessionEnded()
    roomMessages.replaceChildren()
    roomCompose.reset()
    roomCompose.hidden = true
    if (error.status === 403) picker.querySelector('option:checked')?.remove()
    feedback('room-status', error.status === 403 ? 'Room access was removed.' : 'Could not load rooms. Refresh to try again.', true)
  } finally {
    if (roomLoad === job) roomTimer = setTimeout(() => { void loadRooms() }, 5000)
  }
}

picker.addEventListener('change', () => {
  roomCompose.reset()
  void loadRooms({ clear: true })
})
field('refresh-rooms').addEventListener('click', () => { void loadRooms({ clear: true }) })
roomCompose.addEventListener('submit', async event => {
  event.preventDefault()
  const selected = picker.value
  const draft = field('room-message')
  if (!person || roomSending || roomCompose.hidden || !selected || !draft.value.trim()) return
  clearTimeout(roomTimer)
  roomLoad?.abort()
  const job = new AbortController()
  roomLoad = job
  roomSending = picker.disabled = field('room-send').disabled = true
  let failure
  try {
    await api.sendGroup(selected, draft.value, { signal: AbortSignal.any([job.signal, AbortSignal.timeout(10000)]) })
    if (!job.signal.aborted) draft.value = ''
  } catch (error) {
    failure = error
  }
  if (job.signal.aborted) return
  roomSending = picker.disabled = field('room-send').disabled = false
  if (failure?.status === 401) return sessionEnded()
  if (failure?.status === 403) {
    roomMessages.replaceChildren()
    roomCompose.reset()
    roomCompose.hidden = true
  }
  await loadRooms({ clear: failure?.status === 403 })
  if (person && picker.value === selected && !roomCompose.hidden && failure) {
    feedback('room-status', failure.code === 'room-round-in-progress'
      ? '进行中的轮次暂不接收新消息' : 'Could not confirm the send. Check the room before trying again.', true)
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

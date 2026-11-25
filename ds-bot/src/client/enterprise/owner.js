const field = id => document.getElementById(id)
const form = field('owner-form')
const tokenInput = field('token')
const status = field('status')
const messages = field('messages')
const older = field('older')
let token = ''
let filter
let before
let job

function clear() {
  job?.abort()
  token = ''
  filter = undefined
  before = undefined
  form.reset()
  messages.replaceChildren()
  status.textContent = ''
  older.hidden = true
}

function render(page) {
  const turns = document.createDocumentFragment()
  for (const turn of page.turns) {
    const article = document.createElement('article')
    article.className = 'message'
    const time = document.createElement('span')
    time.textContent = new Date(turn.at).toLocaleString()
    article.append(time)
    for (const [author, content] of [[page.personId, turn.text], ...turn.replies.map(text => [page.botId, text])]) {
      const body = document.createElement('p')
      body.textContent = author + ': ' + content
      article.append(body)
    }
    turns.append(article)
  }
  messages.replaceChildren(turns)
}

async function load(cursor) {
  job?.abort()
  const request = new AbortController()
  job = request
  older.hidden = true
  messages.replaceChildren()
  status.textContent = 'Loading transcript…'
  try {
    const response = await fetch('/api/enterprise/owner/transcript', {
      method: 'POST', credentials: 'omit', mode: 'same-origin', redirect: 'error', cache: 'no-store', signal: request.signal,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...filter, before: cursor }),
    })
    if (request.signal.aborted) return
    if (response.status === 401) token = ''
    if (!response.ok) throw new Error('Transcript request failed')
    const page = await response.json()
    if (request.signal.aborted) return
    render(page)
    before = page.nextBefore ?? undefined
    older.hidden = before === undefined
    status.textContent = page.incomplete ? 'Some messages may be missing.' : page.turns.length ? '' : 'No recorded turns.'
  } catch {
    if (!request.signal.aborted) status.textContent = 'Could not read the transcript. Check the credential and filters.'
  }
}

form.addEventListener('submit', event => {
  event.preventDefault()
  token = tokenInput.value.trim() || token
  tokenInput.value = ''
  if (!token) {
    status.textContent = 'Enter the owner token.'
    tokenInput.focus()
    return
  }
  filter = { personId: field('person').value.trim(), botId: field('bot').value.trim() }
  void load()
})
older.addEventListener('click', () => { void load(before) })
field('clear').addEventListener('click', clear)
window.addEventListener('pagehide', clear)

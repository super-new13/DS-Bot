const field = id => document.getElementById(id)
const form = field('owner-form')
const tokenInput = field('token')
const status = field('status')
const messages = field('messages')
const older = field('older')
const ruleForm = field('rule-form')
const ruleAction = field('rule-action')
const ruleStatus = field('rule-status')
const ruleSave = field('rule-save')
let token = ''
let filter
let before
let job
let ruleJob

function clear() {
  job?.abort()
  ruleJob?.abort()
  ruleJob = undefined
  tokenInput.value = ''
  token = ''
  filter = undefined
  before = undefined
  form.reset()
  ruleForm.reset()
  syncRuleFields()
  ruleSave.disabled = false
  ruleStatus.textContent = ''
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

function credential(feedback) {
  token = tokenInput.value.trim() || token
  tokenInput.value = ''
  if (!token) {
    feedback.textContent = 'Enter the owner token.'
    tokenInput.focus()
  }
  return token
}

form.addEventListener('submit', event => {
  event.preventDefault()
  if (!credential(status)) return
  filter = { personId: field('person').value.trim(), botId: field('bot').value.trim() }
  void load()
})
older.addEventListener('click', () => { void load(before) })
field('clear').addEventListener('click', clear)
window.addEventListener('pagehide', clear)

function syncRuleFields() {
  const inactive = ruleAction.value === 'retire'
  const fields = field('rule-fields')
  fields.hidden = fields.disabled = inactive
}

ruleAction.addEventListener('change', syncRuleFields)
syncRuleFields()
ruleForm.addEventListener('submit', async event => {
  event.preventDefault()
  if (ruleJob) return
  const credentialValue = credential(ruleStatus)
  if (!credentialValue) return
  const action = ruleAction.value
  const value = name => field('rule-' + name).value.trim()
  const rule = { id: value('id') }
  if (action !== 'retire') Object.assign(rule, {
    personId: value('person'), botId: value('bot'), roomId: value('room') || null,
    directory: value('directory'), operation: value('operation'), effect: value('effect'), purpose: value('purpose'),
  })
  const request = new AbortController()
  ruleJob = request
  ruleSave.disabled = true
  ruleStatus.textContent = 'Saving rule…'
  try {
    const response = await fetch('/api/enterprise/owner/rule', {
      method: 'POST', credentials: 'omit', mode: 'same-origin', redirect: 'error', cache: 'no-store', signal: request.signal,
      headers: { Authorization: 'Bearer ' + credentialValue, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, rule }),
    })
    if (request.signal.aborted) return
    if (response.status === 401 && token === credentialValue) token = ''
    if (!response.ok) {
      ruleStatus.textContent = ({ 400: 'Check the rule fields.', 401: 'Enter a valid owner token.',
        409: 'This rule cannot be changed with that action.', 503: 'Rule management is unavailable.' })[response.status]
        ?? 'Could not confirm the rule change.'
      return
    }
    const result = await response.json()
    if (!request.signal.aborted) ruleStatus.textContent = 'Saved rule version ' + result.version + '.'
  } catch {
    if (!request.signal.aborted) ruleStatus.textContent = 'Could not confirm the rule change.'
  } finally {
    if (ruleJob === request) {
      ruleJob = undefined
      ruleSave.disabled = false
    }
  }
})

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
const auditForm = field('audit-form')
const auditStatus = field('audit-status')
const auditResults = field('audit-results')
const auditRows = field('audit-rows')
const auditNext = field('audit-next')
const auditColumns = ['type', 'personId', 'botId', 'operation', 'ruleId', 'ruleVersion', 'verdict', 'outcome']
let auditJob
let auditQuery
let auditOffset
let ruleJob

function clear() {
  job?.abort()
  ruleJob?.abort()
  auditJob?.abort()
  auditQuery = auditOffset = undefined
  auditForm.reset()
  auditRows.replaceChildren()
  auditResults.hidden = auditNext.hidden = true
  auditStatus.textContent = ''
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

async function loadAudit(offset = 0) {
  auditJob?.abort()
  const request = new AbortController()
  auditJob = request
  const credentialValue = token
  auditResults.hidden = auditNext.hidden = true
  auditRows.replaceChildren()
  auditStatus.textContent = 'Loading audit records…'
  try {
    const response = await fetch('/api/enterprise/owner/audit', {
      method: 'POST', credentials: 'omit', mode: 'same-origin', redirect: 'error', cache: 'no-store', signal: request.signal,
      headers: { Authorization: 'Bearer ' + credentialValue, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'audit', query: { ...auditQuery, offset } }),
    })
    if (request.signal.aborted) return
    if (response.status === 401 && token === credentialValue) token = ''
    if (!response.ok) {
      auditStatus.textContent = ({ 400: 'Check the filters and worker node ID.', 401: 'Enter a valid owner token.',
        429: 'Too many owner requests. Wait and try again.', 503: 'Audit records are unavailable.' })[response.status]
        ?? 'Could not read audit records.'
      return
    }
    const { events, nextOffset } = await response.json()
    if (request.signal.aborted) return
    if (!Array.isArray(events) || (nextOffset !== null && (!Number.isSafeInteger(nextOffset) || nextOffset <= offset))) {
      throw new Error('Invalid audit page')
    }
    const rows = document.createDocumentFragment()
    for (const event of events) {
      const row = document.createElement('tr')
      for (const key of auditColumns) {
        const cell = document.createElement('td')
        cell.textContent = event[key] ?? '—'
        row.append(cell)
      }
      rows.append(row)
    }
    auditRows.append(rows)
    auditOffset = nextOffset
    auditNext.hidden = nextOffset === null
    auditResults.hidden = events.length === 0
    auditStatus.textContent = events.length ? '' : 'No audit records match these filters.'
  } catch {
    if (!request.signal.aborted) auditStatus.textContent = 'Could not read audit records.'
  }
}

auditForm.addEventListener('submit', event => {
  event.preventDefault()
  if (!credential(auditStatus)) return
  const values = new FormData(auditForm)
  auditQuery = Object.fromEntries([...values].map(([key, value]) => [key, value.trim()]).filter(([, value]) => value))
  void loadAudit()
})
auditNext.addEventListener('click', () => {
  if (Number.isSafeInteger(auditOffset) && credential(auditStatus)) void loadAudit(auditOffset)
})

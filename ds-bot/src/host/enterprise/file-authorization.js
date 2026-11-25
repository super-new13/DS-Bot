const grantFor = new Map([['read', 'read'], ['create', 'write'], ['modify', 'write']])
const identityFields = ['personId', 'botId', 'sessionId', 'requestId', 'dispatchId']
const operationFields = [...identityFields, 'roomId', 'operation', 'path', 'version', 'contentDigest']
const ruleFields = ['id', 'personId', 'botId', 'roomId', 'directory', 'grant', 'effect', 'purpose']
const id = value => typeof value === 'string' && value.length <= 256 && value.trim() !== ''
const boundedText = (value, limit) => typeof value === 'string' && value.length <= limit && value.trim() !== ''
export const absoluteRulePath = value => typeof value === 'string' && value.startsWith('/') && value.length <= 4096
  && !value.includes('\\') && !value.includes('\0')
  && value.slice(1).split('/').every(part => part && part !== '.' && part !== '..')
const exact = (value, fields) => value && typeof value === 'object' && Object.keys(value).length === fields.length
  && fields.every(field => Object.hasOwn(value, field))
const validTime = time => Number.isSafeInteger(time) && time >= 0

function scopedOperation(input) {
  if (!exact(input, operationFields) || !identityFields.every(field => id(input[field]))
      || !(input.roomId === null || id(input.roomId)) || !grantFor.has(input.operation) || !absoluteRulePath(input.path)
      || !(input.operation === 'create' ? input.version === null : boundedText(input.version, 512))
      || !(input.operation === 'read' ? input.contentDigest === null
        : typeof input.contentDigest === 'string' && /^[a-f0-9]{64}$/.test(input.contentDigest))) return undefined
  return Object.freeze(Object.fromEntries(operationFields.map(field => [field, input[field]])))
}

export function validFileRule(rule, { operationOnly = false } = {}) {
  const explicit = Object.hasOwn(rule ?? {}, 'operation')
  const fields = explicit ? [...ruleFields.filter(key => key !== 'grant'), 'operation'] : ruleFields
  return exact(rule, explicit && !operationOnly && Object.hasOwn(rule, 'grant') ? [...fields, 'grant'] : fields)
    && id(rule.id) && id(rule.personId) && id(rule.botId) && (rule.roomId === null || id(rule.roomId))
    && absoluteRulePath(rule.directory) && ['allow', 'deny'].includes(rule.effect) && boundedText(rule.purpose, 512)
    && (explicit ? grantFor.has(rule.operation) && (!Object.hasOwn(rule, 'grant') || ['read', 'write'].includes(rule.grant))
      : !operationOnly && ['read', 'write'].includes(rule.grant))
}

export function matchRules(state, action) {
  if (!id(state?.version) || !Array.isArray(state.rules) || state.rules.length > 1000) return undefined
  const ids = new Set()
  const matches = []
  for (const rule of state.rules) {
    if (!validFileRule(rule) || ids.has(rule.id)) return undefined
    ids.add(rule.id)
    if (rule.personId !== action.personId || rule.botId !== action.botId || rule.roomId !== action.roomId
        || (rule.operation === undefined ? rule.grant !== grantFor.get(action.operation) : rule.operation !== action.operation) || !action.path.startsWith(rule.directory + '/')) continue
    if (rule.effect === 'deny') return undefined
    matches.push(rule)
  }
  if (!matches.length) return undefined
  // Longest directory wins. Rule IDs break equal-directory ties without locale dependence.
  matches.sort((a, b) => b.directory.length - a.directory.length || (a.id < b.id ? -1 : 1))
  const rule = matches[0]
  return { version: state.version, rule: Object.freeze({ ...rule }) }
}

// The host supplies authoritative dispatch identity, current rules, and live access.
// These callbacks run synchronously. Consume at the effect boundary with a freshly
// resolved target/version/digest. Directory matching here is lexical only.
export function createBusinessFileAuthorization({ readRules, isAuthorized, now = Date.now,
  ttlMs = 30_000, maxPending = 256 } = {}) {
  if ([readRules, isAuthorized, now].some(fn => typeof fn !== 'function')
      || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60_000
      || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 4096) {
    throw new TypeError('Invalid business file authorization settings')
  }
  const decisions = new Map()
  const dispatches = new Map()
  let latestTime = 0

  function currentTime() {
    const time = now()
    if (!validTime(time) || time < latestTime) return undefined
    latestTime = time
    return time
  }

  function current(action) {
    try {
      if (isAuthorized(action) !== true) return undefined
      return matchRules(readRules(), action)
    } catch {
      return undefined
    }
  }

  function stillAllowed(record) {
    const live = current(record.action)
    return live?.version === record.version && Object.keys(live.rule).length === Object.keys(record.rule).length
      && Object.keys(record.rule).every(key => live.rule[key] === record.rule[key])
  }

  function prepare(input) {
    const action = scopedOperation(input)
    const time = currentTime()
    if (!action || time === undefined || !validTime(time + ttlMs)) return undefined
    for (const [key, entry] of dispatches) {
      if (entry.expiresAt > time) continue
      dispatches.delete(key)
      decisions.delete(entry.handle)
    }
    const key = JSON.stringify(identityFields.map(field => action[field]))
    if (dispatches.size >= maxPending || dispatches.has(key)) return undefined
    const matched = current(action)
    if (!matched) return undefined
    const handle = Object.freeze({ ruleId: matched.rule.id, ruleVersion: matched.version, purpose: matched.rule.purpose })
    const entry = { ...matched, action, handle, expiresAt: time + ttlMs, phase: 'prepared' }
    decisions.set(handle, entry)
    dispatches.set(key, entry)
    return handle
  }

  // The caller validates the adjudicator's output before passing its verdict here.
  function decide(handle, verdict) {
    const record = decisions.get(handle)
    const time = currentTime()
    if (record?.phase !== 'prepared') return false
    record.phase = 'closed'
    if (verdict !== 'allow' || time === undefined || time >= record.expiresAt || !stillAllowed(record)) return false
    record.phase = 'approved'
    return true
  }

  function consume(handle, input) {
    const record = decisions.get(handle)
    if (record?.phase !== 'approved') return false
    record.phase = 'closed'
    const time = currentTime()
    const action = scopedOperation(input)
    return time !== undefined && time < record.expiresAt && action !== undefined
      && operationFields.every(field => action[field] === record.action[field]) && stillAllowed(record)
  }

  return { prepare, decide, consume }
}

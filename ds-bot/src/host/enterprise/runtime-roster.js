import { nameProblem } from '../../shared/mentions.js'

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const timestamp = value => Number.isSafeInteger(value) && value >= 0

function invalid(field) {
  throw new TypeError('Invalid enterprise roster ' + field)
}

function plain(value) {
  if (!value || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function table(value, field, limit, convert) {
  if (!plain(value)) invalid(field)
  const rows = Object.entries(value)
  if (rows.length > limit) invalid(field)
  const result = Object.create(null)
  for (const [id, row] of rows) {
    if (!validId(id) || !plain(row) || !Object.hasOwn(row, 'id') || row.id !== id) invalid(field)
    result[id] = Object.freeze(convert(row))
  }
  return Object.freeze(result)
}

function references(list, field, limit, allowed) {
  if (!Array.isArray(list) || list.length > limit) invalid(field)
  const result = [...list]
  if (new Set(result).size !== result.length || !result.every(id => validId(id) && allowed(id))) invalid(field)
  return Object.freeze(result)
}

function snapshot(config) {
  if (!plain(config)) invalid('configuration')
  const bots = table(config.bots, 'Bots', Infinity, ({ id, name = id, private: hidden = false, nodeId }) => {
    if (typeof name !== 'string' || name !== name.trim() || name.length > 128 || nameProblem(name)) invalid('Bot name')
    if (typeof hidden !== 'boolean' || (nodeId !== undefined && !validId(nodeId))) invalid('Bot routing')
    return { id, name, private: hidden, nodeId }
  })
  const shareableBot = id => bots[id]?.private === false
  const names = new Set()
  const people = table(config.people, 'people', 200, ({ id, name, color, createdAt, revokedAt, botIds }) => {
    if (typeof name !== 'string' || !name.trim() || name !== name.trim() || Array.from(name).length > 40 || names.has(name)) invalid('employee name')
    names.add(name)
    if ((color !== undefined && (typeof color !== 'string' || !color.trim()))
      || (createdAt !== undefined && !timestamp(createdAt)) || (revokedAt !== undefined && !timestamp(revokedAt))) invalid('employee metadata')
    return { id, name, color, createdAt, revokedAt, botIds: references(botIds, 'employee Bot grants', Infinity, shareableBot) }
  })
  const rooms = table(config.rooms, 'rooms', Infinity, ({ id, people: members, members: botMembers, mode, admin }) => {
    const ordered = references(botMembers, 'room Bot membership', Infinity, shareableBot)
    if ((mode !== undefined && !['admin', 'everyone'].includes(mode)) || (admin !== undefined && !ordered.includes(admin))) invalid('room reply policy')
    if (new Set(ordered.map(botId => bots[botId].name.toLowerCase())).size !== ordered.length) invalid('duplicate room Bot name')
    return { id, ...(mode !== undefined && { mode }), ...(admin !== undefined && { admin }), members: ordered,
      people: references(members, 'room employee membership', 100, personId => Object.hasOwn(people, personId)),
    }
  })
  return Object.freeze({ people, bots, rooms })
}

// readConfig must return the current server-owned configuration synchronously. The
// trusted registry maps node IDs to worker adapters and can update independently.
export function createEnterpriseRuntimeRoster({ readConfig, workers }) {
  if (typeof readConfig !== 'function' || !(workers instanceof Map)) throw new TypeError('Expected enterprise roster source and worker registry')
  const readRoster = () => snapshot(readConfig())
  const resolveBot = botId => {
    if (!validId(botId)) return undefined
    const bot = readRoster().bots[botId]
    if (!bot || bot.private || bot.nodeId === undefined) return undefined
    const worker = workers.get(bot.nodeId)
    if (!worker || !['create', 'submit', 'cancel'].every(key => typeof worker[key] === 'function')) return undefined
    return Object.freeze({ botId, nodeId: bot.nodeId, worker })
  }
  return { readRoster, resolveBot }
}

import { X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { createSecureContext } from 'node:tls'
import { startEmployeeRuntime } from './employee-runtime.js'
import { createEmployeeGroupRuntime } from './group-runtime.js'
import { openEmployeeGroupStore } from './group-store.js'
import { createRoomExecutor } from './room-executor.js'
import { createRemoteWorkerAdapter } from './remote-adapter.js'
import { createEnterpriseRuntimeRoster } from './runtime-roster.js'
import { createWorkerClient } from './worker-client.js'
import { createWorkerTlsTransport } from './worker-tls.js'

function invalid(field) {
  return new TypeError('Invalid employee deployment configuration: ' + field)
}

function exact(value, keys, optional = []) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && keys.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => keys.includes(key) || optional.includes(key))
}

const absolute = value => typeof value === 'string' && isAbsolute(value) && !value.includes('\0')
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const origin = value => typeof value === 'string' && value.startsWith('https://') && URL.parse(value)?.origin === value
const limitsKeys = ['maxActive', 'maxPerBot', 'maxPerNode', 'maxPending']
const groupLimits = ['maxActive', 'maxPending', 'maxPendingPerRoom']

function check(config) {
  if (!exact(config, ['accountFile', 'https', 'workers', 'roster', 'limits'], ['initializeAccounts', 'groups'])) throw invalid('root')
  const { accountFile, initializeAccounts, https, workers, roster, limits } = config
  if (!absolute(accountFile) || (initializeAccounts !== undefined && typeof initializeAccounts !== 'boolean')) throw invalid('accounts')
  if (!exact(https, ['origin', 'host', 'port', 'certFile', 'keyFile']) || !origin(https.origin)
      || typeof https.host !== 'string' || !isIP(https.host) || !Number.isInteger(https.port) || https.port < 0 || https.port > 65535
      || !absolute(https.certFile) || !absolute(https.keyFile)) throw invalid('HTTPS listener')
  if (!exact(limits, limitsKeys) || !limitsKeys.every(key => Number.isSafeInteger(limits[key]) && limits[key] >= (key === 'maxPending' ? 0 : 1))) {
    throw invalid('dispatch limits')
  }
  if (!exact(roster, ['people', 'bots', 'rooms']) || !roster.rooms || typeof roster.rooms !== 'object'
      || Array.isArray(roster.rooms)) throw invalid('rooms table')
  if (config.groups === undefined && Object.keys(roster.rooms).length) throw invalid('rooms require group storage')
  if (config.groups !== undefined && (!exact(config.groups, ['directory'], ['limits', 'roomBots']) || !absolute(config.groups.directory)
      || (config.groups.limits !== undefined && (!exact(config.groups.limits, groupLimits)
        || !groupLimits.every(key => Number.isSafeInteger(config.groups.limits[key]) && config.groups.limits[key] > 0))))) {
    throw invalid('group storage or limits')
  }
  if (!Array.isArray(workers) || !workers.every(worker => exact(worker, ['nodeId', 'origin', 'caFile', 'certFile', 'keyFile'])
      && id(worker.nodeId) && origin(worker.origin) && [worker.caFile, worker.certFile, worker.keyFile].every(absolute))) {
    throw invalid('workers')
  }
  if (new Set(workers.map(worker => worker.nodeId)).size !== workers.length) throw invalid('duplicate worker node')
}

async function loadTls({ caFile, certFile, keyFile }, role) {
  const tls = { minVersion: 'TLSv1.2' }
  for (const [name, path] of [['ca', caFile], ['cert', certFile], ['key', keyFile]]) {
    if (!path) continue
    try { tls[name] = await readFile(path) } catch { throw invalid(role + ' TLS ' + name + ' file') }
  }
  try {
    if (caFile) {
      const pem = tls.ca.toString('ascii')
      const pattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
      const certificates = pem.match(pattern)
      if (!certificates || pem.replace(pattern, '').trim() || !certificates.every(cert => new X509Certificate(cert).ca)) {
        throw new Error('Expected PEM CA certificates')
      }
    }
    createSecureContext(tls)
  } catch {
    throw invalid(role + ' TLS material')
  }
  return tls
}

// The operator supplies a trusted JSON file. Settings and TLS material are loaded
// once per start. Account mutations remain available through the returned service.
export async function startEmployeeDeployment(configFile, { executeRoom } = {}) {
  if (!absolute(configFile)) throw invalid('expected an absolute JSON file path')
  let config
  try { config = JSON.parse(await readFile(configFile, 'utf8')) } catch { throw invalid('could not read JSON file') }
  check(config)
  const { accountFile, initializeAccounts, https, roster, limits, groups } = config
  if (groups !== undefined && groups.roomBots === undefined && typeof executeRoom !== 'function') throw invalid('trusted room executor required')
  if (groups?.roomBots !== undefined && executeRoom !== undefined) throw invalid('ambiguous room executor')
  const workers = new Map()
  const clients = new Map()
  const readConfig = () => roster
  const snapshot = createEnterpriseRuntimeRoster({ readConfig, workers }).readRoster()
  const nodes = new Set(config.workers.map(worker => worker.nodeId))
  for (const bot of Object.values(snapshot.bots)) {
    if ((!bot.private || bot.nodeId !== undefined) && !nodes.has(bot.nodeId)) throw invalid('Bot worker mapping')
  }
  const tls = await loadTls(https, 'employee listener')
  for (const worker of config.workers) {
    const { nodeId, origin } = worker
    const transport = createWorkerTlsTransport({ origin, ...await loadTls(worker, 'worker client') })
    const client = createWorkerClient({ origin, nodeId, transport })
    clients.set(nodeId, client)
    workers.set(nodeId, createRemoteWorkerAdapter({ client, nodeId }))
  }
  const runRoom = groups?.roomBots === undefined ? executeRoom : createRoomExecutor({ roster: snapshot, roomBots: groups.roomBots, clients })
  const groupRuntime = groups === undefined ? undefined : createEmployeeGroupRuntime({
    ...groups.limits, store: await openEmployeeGroupStore(groups.directory),
    async execute(input) {
      const room = snapshot.rooms[input.roomId]
      if (!room?.people.includes(input.source.by)) throw invalid('room execution scope')
      // Room execution receives only room data and original actor attribution.
      const reply = await runRoom(Object.freeze({ ...input, room }))
      if (reply !== undefined && (reply?.roomId !== room.id || !room.members.includes(reply.by))) {
        throw invalid('room reply scope')
      }
      return reply
    },
  })
  return startEmployeeRuntime({ accountFile, initializeAccounts, readConfig, workers, limits,
    https: { origin: https.origin, host: https.host, port: https.port, tls },
    readHistory: groupRuntime?.readHistory ?? (() => undefined), enqueueGroup: groupRuntime?.enqueue ?? (() => false) })
}

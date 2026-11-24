import { X509Certificate } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createSecureContext } from 'node:tls'
import { Context } from '@deepseek-ai/cordis'
import { createFileEvidenceTlsClient } from './file-evidence-tls.js'
import { startFilePolicyRuntime } from './file-policy-runtime.js'
import { createFileReservationTlsClient } from './file-reservation-tls.js'
import { createFileSettlementDelivery } from './file-settlement-delivery.js'
import { createWorkerBootstrap } from './worker-bootstrap.js'

function identity(credentials) {
  const { ca, cert, key } = credentials ?? {}
  if (!ca || !cert || !key) throw new TypeError('Expected independently provisioned client credentials')
  const copy = value => Buffer.isBuffer(value) ? Buffer.from(value) : value
  const tls = { ca: Array.isArray(ca) ? ca.map(copy) : copy(ca), cert: copy(cert), key: copy(key) }
  createSecureContext(tls)
  const leaf = new X509Certificate(tls.cert)
  return { tls, fingerprint: leaf.fingerprint256, publicKey: leaf.publicKey.export({ type: 'spki', format: 'der' }) }
}

async function storageKey(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('Expected absolute file policy storage paths')
  const canonical = await realpath(path).catch(async error => {
    if (error.code !== 'ENOENT') throw error
    return join(await realpath(dirname(path)), basename(path))
  })
  return canonical.normalize('NFC').toLowerCase()
}

// Trusted operators supply both identity registries and live policy. Admission
// policy runs inside the central reservation transaction, including revocation.
export async function startFilePolicyBootstrap({ policy, worker, workerCredentials, producerCredentials } = {}) {
  const { config, adapter, fileTools } = worker ?? {}
  if (!policy?.evidenceListener || !config?.outboxFile || !fileTools?.targetId || !fileTools.path
      || fileTools.permit !== undefined || fileTools.onCompleted !== undefined) {
    throw new TypeError('Expected explicit evidence listener, outbox and guarded target configuration')
  }
  const workerIdentity = identity(workerCredentials)
  const producerIdentity = identity(producerCredentials)
  if (workerIdentity.fingerprint === producerIdentity.fingerprint || workerIdentity.publicKey.equals(producerIdentity.publicKey)) {
    throw new TypeError('Worker and producer credentials overlap')
  }
  const enrolled = (grants, fingerprint) => Array.isArray(grants)
    && grants.some(grant => grant?.fingerprint === fingerprint && grant.nodeId === config.nodeId)
  if (!enrolled(policy.workerGrants, workerIdentity.fingerprint)
      || !enrolled(policy.evidenceListener.producerGrants, producerIdentity.fingerprint)
      || config.peerGrants?.some(grant => grant.fingerprint === producerIdentity.fingerprint)) {
    throw new TypeError('Expected separately enrolled worker and producer identities for this node')
  }
  // The evidence store and outbox share a compatible snapshot shape. They must
  // never share a file because draining the outbox would erase center evidence.
  const centralPaths = await Promise.all([policy.reservationFile, policy.evidenceFile].map(storageKey))
  const workerPaths = await Promise.all([config.outboxFile, config.receiptPath, config.mappingPath, config.auditFile,
    fileTools.path, ...Object.values(config.certPaths ?? {}),
  ].filter(path => path !== undefined).map(storageKey))
  const sessionRoot = config.sessionRoot === undefined ? undefined : await storageKey(config.sessionRoot)
  if (centralPaths.some(path => workerPaths.includes(path) || (sessionRoot && (path === sessionRoot || path.startsWith(sessionRoot + '/'))))) {
    throw new TypeError('Policy and worker storage paths overlap')
  }
  const { targetId, ...localTools } = fileTools
  const profile = new Context()
  let center
  let stopWorker
  let closing
  function close() {
    return closing ??= (async () => {
      try { await stopWorker?.() }
      finally {
        try { await profile.fiber.dispose() }
        finally { await center?.close() }
      }
    })()
  }
  try {
    center = await startFilePolicyRuntime({ ...policy, trustedProducer: Symbol('policy evidence producer') })
    const reservations = createFileReservationTlsClient({ origin: center.origin, ...workerIdentity.tls })
    const ingest = createFileEvidenceTlsClient({ origin: center.evidenceOrigin, ...producerIdentity.tls })
    const deliver = createFileSettlementDelivery({ ingest, reservations })
    let ready
    const bootstrap = createWorkerBootstrap({ config, adapter, ingestEvidence: deliver, onReady: value => { ready = value },
      fileTools: { ...localTools, permit: { nodeId: config.nodeId, path: localTools.path, targetId, client: reservations } },
    })
    stopWorker = await bootstrap.apply(profile)
    return { workerOrigin: ready.origin, reservationOrigin: center.origin, evidenceOrigin: center.evidenceOrigin,
      drainEvidence: ready.drainEvidence, revoke: center.revoke, close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

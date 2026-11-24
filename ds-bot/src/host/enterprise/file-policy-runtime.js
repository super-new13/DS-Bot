import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { startFileEvidenceTls } from './file-evidence-tls.js'
import { openFileReservationStore } from './file-reservation-store.js'
import { startFileReservationTls } from './file-reservation-tls.js'
import { createFileReservations } from './file-reservations.js'
import { openFileSettlementEvidence } from './file-settlement-evidence.js'

const absoluteFile = file => typeof file === 'string' && isAbsolute(file) && !file.includes(String.fromCharCode(0))
const canonicalFile = async file => join(await realpath(dirname(file)), basename(file))

function identityRegistry(grants) {
  if (!Array.isArray(grants) || !grants.length) throw new TypeError('Expected a file policy identity registry')
  const registry = new Map()
  for (const grant of grants) {
    if (!grant || typeof grant !== 'object' || Object.keys(grant).length !== 2
        || !Object.hasOwn(grant, 'fingerprint') || !Object.hasOwn(grant, 'nodeId')) {
      throw new TypeError('Invalid file policy identity grant')
    }
    const { fingerprint, nodeId } = grant
    if (typeof fingerprint !== 'string' || !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(fingerprint)
        || typeof nodeId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(nodeId) || registry.has(fingerprint)) {
      throw new TypeError('Invalid file policy identity grant')
    }
    registry.set(fingerprint, nodeId)
  }
  return registry
}

async function closeAll(...resources) {
  const results = await Promise.allSettled(resources.map(async resource => resource?.close()))
  const failed = results.find(result => result.status === 'rejected')
  if (failed) throw failed.reason
}

// Network evidence ingestion uses a separate, explicitly enrolled identity set.
// The reservation listener only has access to the read-only verifier.
export async function startFilePolicyRuntime({ reservationFile, evidenceFile, initialize = false,
  trustedProducer, canReserve, resolveWorker, workerGrants, authorizeScope, listener, evidenceListener } = {}) {
  if (![reservationFile, evidenceFile].every(absoluteFile) || typeof initialize !== 'boolean'
      || typeof trustedProducer !== 'symbol' || ![canReserve, authorizeScope].every(fn => typeof fn === 'function')
      || !listener?.tls?.ca || !listener.tls.cert || !listener.tls.key) {
    throw new TypeError('Invalid file policy runtime configuration')
  }
  let workerIdentity = resolveWorker
  let producerGrants
  if (evidenceListener !== undefined) {
    if (resolveWorker !== undefined || !evidenceListener?.tls?.ca || !evidenceListener.tls.cert || !evidenceListener.tls.key) {
      throw new TypeError('Evidence listener requires explicit worker and producer registries')
    }
    const workers = identityRegistry(workerGrants)
    const producers = identityRegistry(evidenceListener.producerGrants)
    for (const fingerprint of producers.keys()) {
      if (workers.has(fingerprint)) throw new TypeError('File policy identity registries overlap')
    }
    workerIdentity = fingerprint => workers.get(fingerprint)
    producerGrants = Array.from(producers, ([fingerprint, nodeId]) => ({ fingerprint, nodeId }))
  } else if (workerGrants !== undefined || typeof workerIdentity !== 'function') {
    throw new TypeError('Expected a worker identity resolver')
  }
  const [reservationPath, evidencePath] = await Promise.all([canonicalFile(reservationFile), canonicalFile(evidenceFile)])
  if (reservationPath === evidencePath) throw new TypeError('File policy stores must be separate files')

  let reservationStore
  let evidenceStore
  let entry
  let producerEntry
  let closing
  function close() {
    return closing ??= (async () => {
      try { await closeAll(entry, producerEntry) }
      finally { await closeAll(reservationStore, evidenceStore) }
    })()
  }

  try {
    reservationStore = await openFileReservationStore(reservationPath, { initialize })
    evidenceStore = await openFileSettlementEvidence(evidencePath, { trustedProducer, initialize })
    const reservations = createFileReservations({ transact: reservationStore.transact, canReserve })
    entry = await startFileReservationTls({ ...listener, reservations, resolveWorker: workerIdentity, authorizeScope,
      verifySettlement: evidenceStore.verifySettlement,
    })
    if (producerGrants) {
      producerEntry = await startFileEvidenceTls({ ...evidenceListener, producerGrants,
        ingest: evidence => evidenceStore.ingest(trustedProducer, evidence),
      })
    }
    return { origin: entry.origin, address: entry.address, revoke: reservations.revoke, ingest: evidenceStore.ingest, close,
      ...(producerEntry && { evidenceOrigin: producerEntry.origin, evidenceAddress: producerEntry.address }),
    }
  } catch (error) {
    await close()
    throw error
  }
}

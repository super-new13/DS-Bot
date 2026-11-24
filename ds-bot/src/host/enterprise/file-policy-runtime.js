import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { openFileReservationStore } from './file-reservation-store.js'
import { startFileReservationTls } from './file-reservation-tls.js'
import { createFileReservations } from './file-reservations.js'
import { openFileSettlementEvidence } from './file-settlement-evidence.js'

const absoluteFile = file => typeof file === 'string' && isAbsolute(file) && !file.includes(String.fromCharCode(0))
const canonicalFile = async file => join(await realpath(dirname(file)), basename(file))

// Only trusted local callers receive revoke and ingest. The TLS handler gets
// the read-only evidence verifier and can settle only an existing reservation.
export async function startFilePolicyRuntime({ reservationFile, evidenceFile, initialize = false,
  trustedProducer, canReserve, resolveWorker, authorizeScope, listener } = {}) {
  if (![reservationFile, evidenceFile].every(absoluteFile) || typeof initialize !== 'boolean'
      || typeof trustedProducer !== 'symbol' || ![canReserve, resolveWorker, authorizeScope].every(fn => typeof fn === 'function')
      || !listener?.tls?.ca || !listener.tls.cert || !listener.tls.key) {
    throw new TypeError('Invalid file policy runtime configuration')
  }
  const [reservationPath, evidencePath] = await Promise.all([canonicalFile(reservationFile), canonicalFile(evidenceFile)])
  if (reservationPath === evidencePath) throw new TypeError('File policy stores must be separate files')

  let reservationStore
  let evidenceStore
  let entry
  let closing
  function close() {
    return closing ??= (async () => {
      try { await entry?.close() }
      finally { await Promise.all([reservationStore?.close(), evidenceStore?.close()]) }
    })()
  }

  try {
    reservationStore = await openFileReservationStore(reservationPath, { initialize })
    evidenceStore = await openFileSettlementEvidence(evidencePath, { trustedProducer, initialize })
    const reservations = createFileReservations({ transact: reservationStore.transact, canReserve })
    entry = await startFileReservationTls({ ...listener, reservations, resolveWorker, authorizeScope,
      verifySettlement: evidenceStore.verifySettlement,
    })
    return { origin: entry.origin, address: entry.address, revoke: reservations.revoke, ingest: evidenceStore.ingest, close }
  } catch (error) {
    await close()
    throw error
  }
}

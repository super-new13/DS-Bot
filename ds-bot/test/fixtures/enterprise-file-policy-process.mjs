import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { createFileEvidenceTlsClient } from '../../src/host/enterprise/file-evidence-tls.js'
import { startFilePolicyRuntime } from '../../src/host/enterprise/file-policy-runtime.js'
import { createFileReservationTlsClient } from '../../src/host/enterprise/file-reservation-tls.js'
import { createFileSettlementDelivery } from '../../src/host/enterprise/file-settlement-delivery.js'
import { createWorkerBootstrap } from '../../src/host/enterprise/worker-bootstrap.js'

const [role, dir, reservationOrigin, evidenceOrigin] = process.argv.slice(2)
const file = name => join(dir, name)
const tls = name => ({ ca: readFileSync(file('ca.pem')), cert: readFileSync(file(name + '.pem')), key: readFileSync(file(name + '.key')) })
const fingerprint = name => new X509Certificate(readFileSync(file(name + '.pem'))).fingerprint256
const nodeId = 'node'
const personId = 'alice'
const botId = 'helper'
const owns = scope => scope.nodeId === nodeId && scope.personId === personId && scope.botId === botId && scope.roomId === null

class MockModel extends LlmAdapter {
  used = false
  providerInfo() { return { id: 'mock', name: 'Mock' } }
  async resolveModel(provider, id) {
    return { provider, id, name: id, inputModalities: ['text'], context: { contextWindow: 100000 }, defaultMaxTokens: 1000 }
  }
  async *stream() {
    if (this.used) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
    this.used = true
    const name = 'worker_replace_file'
    const id = 'fixture-call'
    yield { type: 'block-start', index: 0, blockType: 'tool-call', id, name }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: JSON.stringify({ content: 'updated' }) } }
    yield { type: 'finish', reason: { kind: 'tool-use' } }
  }
}

let close
let command
let ready
if (role === 'center') {
  const center = await startFilePolicyRuntime({ reservationFile: file('reservations.json'), evidenceFile: file('evidence.json'),
    initialize: true, trustedProducer: Symbol('fixture producer'), listener: { tls: tls('server') },
    workerGrants: [{ fingerprint: fingerprint('worker'), nodeId }],
    evidenceListener: { tls: tls('server'), producerGrants: [{ fingerprint: fingerprint('producer'), nodeId }] },
    authorizeScope: (node, _action, scope) => node === nodeId && owns(scope),
    canReserve: scope => owns(scope) && scope.targetId === 'note' && scope.ruleId === 'edit' && scope.ruleVersion === 'v1',
  })
  close = center.close
  command = action => action === 'revoke' && center.revoke(personId)
  ready = { reservationOrigin: center.origin, evidenceOrigin: center.evidenceOrigin }
} else if (role === 'worker') {
  const reservations = createFileReservationTlsClient({ origin: reservationOrigin, ...tls('worker') })
  const deliver = createFileSettlementDelivery({ reservations, ingest: createFileEvidenceTlsClient({ origin: evidenceOrigin, ...tls('producer') }) })
  const profile = new Context()
  const root = file('owned')
  const path = join(root, 'note')
  const bootstrap = createWorkerBootstrap({ adapter: new MockModel(), ingestEvidence: deliver, onReady: value => { ready = value },
    config: { nodeId, provider: 'mock', model: 'model', initialize: true, receiptPath: file('receipts.json'), outboxFile: file('outbox.json'),
      certPaths: { ca: file('ca.pem'), cert: file('server.pem'), key: file('server.key') },
      peerGrants: [{ fingerprint: fingerprint('controller'), personId, botId, actions: ['create', 'submit', 'status'] }],
    },
    fileTools: { root, path, workerOwned: true, isAuthorized: action => action.requestId === 'fixture-request',
      permit: { nodeId, targetId: 'note', path, client: reservations },
      readRules: () => ({ version: 'v1', rules: [{ id: 'edit', personId, botId, roomId: null,
        directory: root, grant: 'write', effect: 'allow', purpose: 'Update fixture note',
      }] }),
      adjudicate: ({ rule }) => ({ verdict: 'allow', ruleId: rule.id, ruleVersion: rule.version, reason: 'Fixture approval' }),
    },
  })
  await profile.plugin(bootstrap)
  close = () => profile.fiber.dispose()
  const { origin, drainEvidence } = ready
  command = action => action === 'drain' && drainEvidence({ limit: 1 })
  ready = { origin }
} else throw new Error('Invalid fixture role')

process.on('message', async action => {
  try {
    if (action === 'close') {
      await close()
      process.disconnect()
      return
    }
    process.send({ result: await command(action) })
  } catch (error) {
    process.send({ error: error.message })
  }
})
process.on('disconnect', () => { void close() })
process.send(ready)

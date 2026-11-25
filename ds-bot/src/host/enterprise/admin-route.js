import { createEmployeeAdminService } from './admin-service.js'

const path = '/api/bot/enterprise-admin'
const operations = new Set(['invite', 'revoke', 'audit'])
const headers = { 'Cache-Control': 'no-store' }
const reply = (status, body) => Response.json(body, { status, headers })

export function registerEmployeeAdminRoute(ctx, { accounts, readRoster, auditStore } = {}) {
  const admitted = new WeakSet()
  const service = createEmployeeAdminService({ accounts, readRoster, auditStore,
    isOwner: context => admitted.has(context) && !context.signal.aborted,
  })

  ctx.effect(() => ctx.connection.fetch.register({
    path,
    methods: ['POST'],
    requestBody: 'buffered',
    // Exact Fetch callbacks receive only requests already admitted as owner by DSH.
    async fetch(request) {
      if (request.signal.aborted) return reply(403, { error: 'Operation refused' })
      const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
      if (type !== 'application/json') return reply(415, { error: 'Expected JSON' })
      let input
      try { input = await request.json() } catch { return reply(400, { error: 'Invalid request' }) }
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
          || !Object.hasOwn(input, 'operation') || (input.operation === 'audit' ? !Object.hasOwn(input, 'query')
            : !Object.hasOwn(input, 'personId') || typeof input.personId !== 'string')) {
        return reply(400, { error: 'Invalid request' })
      }
      if (!operations.has(input.operation)) return reply(403, { error: 'Operation refused' })
      const owner = Object.freeze({ signal: request.signal })
      admitted.add(owner)
      try {
        if (input.operation === 'audit') {
          if (!service.audit) return reply(503, { error: 'Audit records unavailable' })
          return reply(200, await service.audit(owner, input.query))
        }
        const result = await service[input.operation](owner, input.personId)
        if (!result) return reply(409, { error: 'Account state does not allow this operation' })
        return input.operation === 'invite' ? reply(201, result) : new Response(null, { status: 204, headers })
      } catch (error) {
        if (error?.code === 'invalid-audit-query') return reply(400, { error: 'Invalid audit query' })
        if (input.operation === 'audit' && error?.code !== 'not-authorized') return reply(503, { error: 'Audit records unavailable' })
        return error?.code === 'not-authorized'
          ? reply(403, { error: 'Operation refused' })
          : reply(500, { error: 'Account operation could not be confirmed' })
      } finally {
        admitted.delete(owner)
      }
    },
  }), 'ds-bot: employee administration route')
}

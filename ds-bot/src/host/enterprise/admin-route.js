import { createEmployeeAdminService } from './admin-service.js'

const path = '/api/bot/enterprise-admin'
const operations = new Set(['invite', 'revoke'])
const headers = { 'Cache-Control': 'no-store' }
const reply = (status, body) => Response.json(body, { status, headers })

export function registerEmployeeAdminRoute(ctx, { accounts, readRoster } = {}) {
  const admitted = new WeakSet()
  const service = createEmployeeAdminService({ accounts, readRoster,
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
          || !Object.hasOwn(input, 'operation') || !Object.hasOwn(input, 'personId') || typeof input.personId !== 'string') {
        return reply(400, { error: 'Invalid request' })
      }
      if (!operations.has(input.operation)) return reply(403, { error: 'Operation refused' })
      const owner = Object.freeze({ signal: request.signal })
      admitted.add(owner)
      try {
        const result = await service[input.operation](owner, input.personId)
        if (!result) return reply(409, { error: 'Account state does not allow this operation' })
        return input.operation === 'invite' ? reply(201, result) : new Response(null, { status: 204, headers })
      } catch (error) {
        return error?.code === 'not-authorized'
          ? reply(403, { error: 'Operation refused' })
          : reply(500, { error: 'Account operation could not be confirmed' })
      } finally {
        admitted.delete(owner)
      }
    },
  }), 'ds-bot: employee administration route')
}

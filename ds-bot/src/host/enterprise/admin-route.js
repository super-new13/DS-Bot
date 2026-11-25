import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createEmployeeAdminService } from './admin-service.js'
import { parseTranscriptFilter } from './transcript-view.js'

const path = '/api/bot/enterprise-admin'
const view = path + '/transcripts'
const script = view + '/page.js'
const operations = new Set(['invite', 'revoke', 'audit', 'transcript'])
const headers = { 'Cache-Control': 'no-store' }
const reply = (status, body) => Response.json(body, { status, headers })

const page = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Employee private transcripts</title>
<main><h1>Employee private transcripts</h1>
<p>This view covers messages recorded by the center after recording was enabled. Each read is audited.</p>
<form id="owner-transcript">
<label>Employee ID <input name="personId" required maxlength="128"></label>
<label>Bot ID <input name="botId" required maxlength="128"></label>
<button type="submit">View transcript</button>
</form>
<p id="transcript-status" role="status"></p>
<div id="transcript-turns"></div>
<button id="transcript-older" type="button" hidden>Older turns</button>
</main><script type="module" src="${script}"></script></html>`

function registerTranscriptPage(ctx) {
  const security = { ...headers, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" }
  for (const [assetPath, contentType, body] of [
    [view, 'text/html; charset=utf-8', () => page],
    ...['page.js', 'api.js'].map(name => [view + '/' + name, 'text/javascript; charset=utf-8',
      () => readFile(new URL('../../client/enterprise/' + name, import.meta.url))]),
  ]) {
    ctx.effect(() => ctx.connection.fetch.register({ path: assetPath, methods: ['GET'], async fetch(request) {
      if (request.signal.aborted) return reply(403, { error: 'Operation refused' })
      return new Response(await body(), { headers: { ...security, 'Content-Type': contentType } })
    } }), 'ds-bot: owner private transcript page')
  }
}

export function registerEmployeeAdminRoute(ctx, { accounts, readRoster, auditStore, transcriptStore } = {}) {
  const admitted = new WeakSet()
  const service = createEmployeeAdminService({ accounts, readRoster, auditStore, transcriptStore,
    isOwner: context => admitted.has(context) && !context.signal.aborted,
  })
  if (transcriptStore) registerTranscriptPage(ctx)

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
      if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input, 'operation')) {
        return reply(400, { error: 'Invalid request' })
      }
      if (!operations.has(input.operation)) return reply(403, { error: 'Operation refused' })
      const transcript = input.operation === 'transcript'
      const audit = input.operation === 'audit'
      const filter = transcript ? parseTranscriptFilter(input) : undefined
      const scoped = Object.keys(input).length === 2 && Object.hasOwn(input, 'personId') && typeof input.personId === 'string'
      if (audit ? !Object.hasOwn(input, 'query') || Object.keys(input).length !== 2 : transcript ? !filter : !scoped) {
        return reply(400, { error: 'Invalid request' })
      }
      const owner = Object.freeze({ signal: request.signal, requestId: randomUUID(), at: Date.now() })
      admitted.add(owner)
      try {
        if (audit) {
          if (!service.audit) return reply(503, { error: 'Audit records unavailable' })
          return reply(200, await service.audit(owner, input.query))
        }
        const result = await service[input.operation](owner, transcript ? filter : input.personId)
        if (transcript) return reply(200, result)
        if (!result) return reply(409, { error: 'Account state does not allow this operation' })
        return input.operation === 'invite' ? reply(201, result) : new Response(null, { status: 204, headers })
      } catch (error) {
        if (error?.code === 'invalid-audit-query') return reply(400, { error: 'Invalid audit query' })
        if (audit && error?.code !== 'not-authorized') return reply(503, { error: 'Audit records unavailable' })
        return error?.code === 'not-authorized'
          ? reply(403, { error: 'Operation refused' })
          : reply(500, { error: transcript ? 'Transcript could not be read' : 'Account operation could not be confirmed' })
      } finally {
        admitted.delete(owner)
      }
    },
  }), 'ds-bot: employee administration route')
}

export function createStandaloneOwnerHandler({ accounts, readRoster, isOwner, transcriptStore, ruleStore, auditStore }) {
  const capabilities = new WeakMap()
  const service = createEmployeeAdminService({ accounts, readRoster, transcriptStore, ruleStore, auditStore,
    isOwner: context => !context?.signal.aborted && isOwner(capabilities.get(context)) })

  return async (request, admitted) => {
    if (!isOwner(admitted)) return reply(401, { error: 'Owner credential required' })
    const operation = new URL(request.url).pathname.split('/').at(-1)
    if (request.method !== 'POST' || !(operations.has(operation) || operation === 'rule')) return reply(404, { error: 'Not found' })
    const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
    if (type !== 'application/json') return reply(415, { error: 'Expected JSON' })
    let body
    try { body = await request.json() } catch { return reply(400, { error: 'Invalid request' }) }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply(400, { error: 'Invalid request' })
    }
    const audit = operation === 'audit'
    if (audit ? Object.keys(body).length !== 2 || body.operation !== 'audit' || !Object.hasOwn(body, 'query')
      : Object.hasOwn(body, 'operation')) return reply(400, { error: 'Invalid request' })
    const filter = operation === 'transcript' ? parseTranscriptFilter(body) : undefined
    if (!audit && operation !== 'rule' && (operation === 'transcript' ? !filter : Object.keys(body).length !== 1 || typeof body.personId !== 'string')) {
      return reply(400, { error: 'Invalid request' })
    }
    const context = Object.freeze({ requestId: randomUUID(), at: Date.now(), signal: request.signal })
    capabilities.set(context, admitted)
    try {
      if (audit) {
        if (!service.audit) return reply(503, { error: 'Audit records unavailable' })
        return reply(200, await service.audit(context, body.query))
      }
      if (operation === 'rule') return reply(body.action === 'create' ? 201 : 200, await service.rule(context, body))
      const result = await service[operation](context, filter ?? body.personId)
      if (operation === 'transcript') return reply(200, result)
      if (!result) return reply(409, { error: 'Account state does not allow this operation' })
      return operation === 'invite' ? reply(201, result) : new Response(null, { status: 204, headers })
    } catch (error) {
      if (audit) return error?.code === 'invalid-audit-query'
        ? reply(400, { error: 'Invalid audit query' })
        : reply(503, { error: 'Audit records unavailable' })
      if (error?.code === 'invalid-rule') return reply(400, { error: 'Invalid rule update' })
      if (error?.code === 'rule-conflict') return reply(409, { error: 'Rule state does not allow this change' })
      if (error?.code === 'rule-unavailable') return reply(503, { error: 'Rule store unavailable' })
      return error?.code === 'not-authorized' ? reply(403, { error: 'Operation refused' })
        : reply(500, { error: 'Owner operation could not be confirmed' })
    } finally {
      capabilities.delete(context)
    }
  }
}

import { createServer } from 'node:https'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const routes = new Map([
  ['/api/enterprise/auth/redeem', 'POST'],
  ['/api/enterprise/auth/login', 'POST'],
  ['/api/enterprise/auth/logout', 'POST'],
  ['/api/enterprise/auth/session', 'GET'],
  ['/api/enterprise/private-chat/send', 'POST'],
  ['/api/enterprise/private-chat/cancel', 'POST'],
])
const groupRoute = /^\/api\/enterprise\/group-chat\/[A-Za-z0-9_-]{1,128}\/(history|send)$/

export function employeeRoute(path) {
  const method = routes.get(path)
  if (method) return { method, group: false }
  const operation = groupRoute.exec(path)?.[1]
  if (operation) return { method: operation === 'history' ? 'GET' : 'POST', group: true }
}

const requestFields = ['content-type', 'content-length', 'content-encoding', 'origin', 'sec-fetch-site', 'cookie']
const hopByHop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']

function reject(res, status, headers) {
  res.writeHead(status, { 'Cache-Control': 'no-store', Connection: 'close', ...headers }).end()
}

function readBody(req, maxBytes, timeoutMs) {
  return new Promise(resolve => {
    const chunks = []
    let size = 0
    const timer = setTimeout(() => finish({ status: 408 }), timeoutMs)
    function finish(result) {
      clearTimeout(timer)
      req.pause()
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('close', onClose)
      resolve(result)
    }
    function onData(chunk) {
      size += chunk.byteLength
      if (size > maxBytes) finish({ status: 413 })
      else chunks.push(chunk)
    }
    const onEnd = () => finish({ body: Buffer.concat(chunks, size) })
    const onClose = () => finish({ status: 400 })
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('close', onClose)
  })
}

async function writeResponse(res, output, signal) {
  const excluded = new Set([...hopByHop, ...(output.headers.get('connection') ?? '').toLowerCase().split(',').map(name => name.trim())])
  const cookies = output.headers.getSetCookie()
  for (const [name, value] of output.headers) {
    if (name !== 'set-cookie' && !excluded.has(name)) res.setHeader(name, value)
  }
  if (cookies.length && !excluded.has('set-cookie')) res.setHeader('Set-Cookie', cookies)
  res.statusCode = output.status
  if (!output.body) {
    res.end()
    return
  }
  res.flushHeaders()
  await pipeline(Readable.fromWeb(output.body), res, { signal })
}

async function handle(req, res, { origin, authority, handler, employeeAsset, maxBodyBytes, bodyTimeoutMs }) {
  if (req.headersDistinct.host?.length !== 1 || req.headers.host?.toLowerCase() !== authority) return reject(res, 404)
  const method = employeeRoute(req.url?.split('?', 1)[0])?.method
  if (!method) {
    const asset = employeeAsset?.(req.url)
    if (!asset) return reject(res, 404)
    if (req.method !== 'GET' && req.method !== 'HEAD') return reject(res, 405, { Allow: 'GET, HEAD' })
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0) return reject(res, 400)
    res.writeHead(200, asset.headers).end(req.method === 'HEAD' ? undefined : asset.body)
    return
  }
  if (req.method !== method) return reject(res, 405, { Allow: method })
  const headers = new Headers()
  for (const name of requestFields) {
    if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name])
  }
  const declared = headers.get('content-length')
  if (declared !== null && !/^\d+$/.test(declared)) return reject(res, 400)
  if (Number(declared) > maxBodyBytes) return reject(res, 413)
  const hasBody = Boolean(req.headers['transfer-encoding']) || Number(declared) > 0
  if (method === 'GET' && hasBody) return reject(res, 400)

  const abort = new AbortController()
  res.once('close', () => { if (!res.writableFinished) abort.abort() })
  const { status, body } = hasBody ? await readBody(req, maxBodyBytes, bodyTimeoutMs) : {}
  if (abort.signal.aborted) return
  if (status) return reject(res, status)

  const input = new Request(origin + req.url, { method, headers, body, signal: abort.signal })
  // Direct TLS peers only. A reverse proxy would need its own authenticated client-address contract.
  const output = await handler(input, { clientKey: req.socket.remoteAddress })
  if (abort.signal.aborted) {
    await output.body?.cancel()
    return
  }
  await writeResponse(res, output, abort.signal)
}

// Returns the bound address and an idempotent close which aborts live connections.
export async function startEnterpriseHttpsEntry({ tls, origin, handler, employeeAsset, host = '127.0.0.1', port = 0,
  maxBodyBytes = 65536, bodyTimeoutMs = 5000, headersTimeoutMs = 10000, idleTimeoutMs = 60000,
  maxConnections = 128 } = {}) {
  const publicUrl = new URL(origin)
  if (publicUrl.protocol !== 'https:' || publicUrl.origin !== origin) throw new TypeError('Expected a canonical HTTPS origin')
  if (!tls || typeof handler !== 'function') throw new TypeError('Expected TLS settings and an enterprise handler')
  for (const value of [maxBodyBytes, bodyTimeoutMs, headersTimeoutMs, idleTimeoutMs, maxConnections]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2 ** 31 - 1) throw new RangeError('Invalid HTTPS entry limit')
  }
  const sockets = new Set()
  const options = { origin, authority: publicUrl.host, handler, employeeAsset, maxBodyBytes, bodyTimeoutMs }
  const server = createServer({ ...tls, insecureHTTPParser: false, headersTimeout: headersTimeoutMs,
    requestTimeout: Math.min(2 ** 31 - 1, headersTimeoutMs + bodyTimeoutMs),
    connectionsCheckingInterval: Math.min(headersTimeoutMs, bodyTimeoutMs, 1000),
    handshakeTimeout: headersTimeoutMs, keepAliveTimeout: 5000, maxHeaderSize: 8192 }, (req, res) => {
    req.on('error', () => res.destroy())
    void handle(req, res, options).catch(() => {
      if (res.destroyed) return
      if (res.headersSent) res.destroy()
      else {
        for (const name of res.getHeaderNames()) res.removeHeader(name)
        reject(res, 500)
      }
    })
  })
  server.on('checkContinue', (_req, res) => reject(res, 417))
  server.maxConnections = maxConnections
  server.maxRequestsPerSocket = 1
  server.setTimeout(idleTimeoutMs, socket => socket.destroy())
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, rejectStart) => {
    server.once('error', rejectStart)
    server.listen(port, host, () => {
      server.off('error', rejectStart)
      resolve()
    })
  })
  let closing
  return {
    address: server.address(),
    close() {
      return closing ??= new Promise((resolve, rejectClose) => {
        server.close(error => error ? rejectClose(error) : resolve())
        for (const socket of sockets) socket.destroy()
      })
    },
  }
}

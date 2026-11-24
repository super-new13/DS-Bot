import { addAbortListener } from 'node:events'
import { createServer, request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { checkServerIdentity } from 'node:tls'

const paths = new Set(['create', 'submit', 'cancel', 'status'].map(action => '/internal/enterprise/worker/' + action))
const requestFields = ['content-type', 'content-encoding']
const validLimit = value => Number.isSafeInteger(value) && value >= 1 && value <= 2 ** 31 - 1
const transportError = code => Object.assign(new Error(code), { code })

async function requestBytes(request, limit, signal) {
  if (!request.body) return Buffer.alloc(0)
  const reader = request.body.getReader()
  const abort = addAbortListener(signal, () => { void reader.cancel().catch(() => {}) })
  const chunks = []
  let bytes = 0
  try {
    signal.throwIfAborted()
    while (true) {
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) return Buffer.concat(chunks, bytes)
      bytes += value.byteLength
      if (bytes > limit) throw transportError('worker-body-too-large')
      chunks.push(value)
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    abort[Symbol.dispose]()
    reader.releaseLock()
  }
}

// Trust roots and the client identity are supplied by the caller. The HTTPS
// origin also sets the identity used for Node's standard certificate check.
export function createWorkerTlsTransport(options) {
  return createInternalTlsTransport(options, paths)
}

export function createInternalTlsTransport({ origin, ca, cert, key, timeoutMs = 30000, maxBodyBytes = 65536 }, allowedPaths) {
  const routes = new Set(allowedPaths)
  const expected = new URL(origin)
  if (expected.protocol !== 'https:' || expected.origin !== origin || !ca || !cert || !key
      || !validLimit(timeoutMs) || !validLimit(maxBodyBytes)) throw new TypeError('Invalid worker TLS client configuration')
  return async request => {
    const url = new URL(request.url)
    if (url.origin !== origin || !routes.has(url.pathname) || url.search || url.hash || request.method !== 'POST' || request.redirect !== 'error') {
      throw transportError('worker-route-refused')
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
    const body = await requestBytes(request, maxBodyBytes, signal)
    const headers = { 'content-length': String(body.byteLength) }
    for (const name of requestFields) {
      const value = request.headers.get(name)
      if (value !== null) headers[name] = value
    }
    return new Promise((resolve, reject) => {
      const req = httpsRequest(url, {
        method: 'POST', ca, cert, key, headers, signal, agent: false,
        rejectUnauthorized: true, minVersion: 'TLSv1.2', checkServerIdentity,
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.destroy()
          reject(transportError('worker-redirect-refused'))
          return
        }
        const fields = new Headers()
        for (const name of ['content-type', 'cache-control']) {
          if (typeof res.headers[name] === 'string') fields.set(name, res.headers[name])
        }
        if (res.statusCode === 204 || res.statusCode === 205) {
          res.resume()
          resolve(new Response(null, { status: res.statusCode, headers: fields }))
          return
        }
        resolve(new Response(Readable.toWeb(res), { status: res.statusCode, headers: fields }))
      })
      req.once('error', reject)
      req.end(body)
    })
  }
}

// The bind address and the HTTPS authority can differ on a private network.
// The worker handler applies peer grants to the verified leaf fingerprint.
export async function startLocalWorkerTls(options) {
  return startInternalTls(options, paths)
}

export async function startInternalTls({ ca, cert, key, handler, host = '127.0.0.1', port = 0, origin,
  timeoutMs = 30000, maxBodyBytes = 65536, maxConnections = 32 }, allowedPaths) {
  const routes = new Set(allowedPaths)
  if (!ca || !cert || !key || typeof handler !== 'function'
      || ![timeoutMs, maxBodyBytes, maxConnections].every(validLimit)
      || typeof host !== 'string' || !host.trim() || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('Invalid local worker TLS configuration')
  }
  if (origin === undefined ? host !== '127.0.0.1'
    : typeof origin !== 'string' || !origin.startsWith('https://') || URL.parse(origin)?.origin !== origin) {
    throw new TypeError('Expected an explicit canonical HTTPS worker origin')
  }
  const sockets = new Set()
  let authority = origin === undefined ? undefined : new URL(origin).host
  const server = createServer({
    ca, cert, key, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2', handshakeTimeout: timeoutMs,
    headersTimeout: timeoutMs, requestTimeout: timeoutMs, connectionsCheckingInterval: Math.min(timeoutMs, 1000),
    maxHeaderSize: 8192,
  }, (req, res) => {
    const lifetime = new AbortController()
    const timer = setTimeout(() => { lifetime.abort(); res.destroy() }, timeoutMs)
    res.once('close', () => { clearTimeout(timer); lifetime.abort() })
    req.on('error', () => res.destroy())
    const reject = status => res.writeHead(status, { Connection: 'close', 'Cache-Control': 'no-store' }).end()
    void (async () => {
      const fingerprint = req.socket.getPeerCertificate().fingerprint256
      if (!req.socket.authorized || !fingerprint) return reject(403)
      if (req.headersDistinct.host?.length !== 1 || req.headers.host?.toLowerCase() !== authority || !routes.has(req.url)) return reject(404)
      if (req.method !== 'POST') return reject(405)
      if (Number(req.headers['content-length']) > maxBodyBytes) return reject(413)
      const chunks = []
      let size = 0
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.byteLength
        if (size > maxBodyBytes) return reject(413)
        chunks.push(chunk)
      }
      if (lifetime.signal.aborted) return
      const headers = new Headers()
      for (const name of [...requestFields, 'content-length']) {
        if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name])
      }
      const request = new Request(origin + req.url, { method: 'POST', body: Buffer.concat(chunks, size), headers, signal: lifetime.signal })
      const output = await handler(request, Object.freeze({ fingerprint }))
      if (lifetime.signal.aborted) {
        void output.body?.cancel().catch(() => {})
        return
      }
      res.setHeader('Connection', 'close')
      res.setHeader('Cache-Control', 'no-store')
      for (const name of ['content-type', 'location']) {
        const value = output.headers.get(name)
        if (value !== null) res.setHeader(name, value)
      }
      res.writeHead(output.status)
      if (!output.body) return res.end()
      res.flushHeaders()
      await pipeline(Readable.fromWeb(output.body), res, { signal: lifetime.signal })
    })().catch(() => {
      if (res.headersSent) res.destroy()
      else if (!res.destroyed) reject(503)
    })
  })
  server.maxConnections = maxConnections
  server.maxRequestsPerSocket = 1
  server.on('checkContinue', (_req, res) => res.writeHead(417, { Connection: 'close' }).end())
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  origin ??= 'https://127.0.0.1:' + address.port
  authority ??= new URL(origin).host
  let closing
  return { origin, address, close() {
    return closing ??= new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      for (const socket of sockets) socket.destroy()
    })
  } }
}

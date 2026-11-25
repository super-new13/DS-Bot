import { readFile } from 'node:fs/promises'

const assets = [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/page.css', 'page.css', 'text/css; charset=utf-8'],
  ['/page.js', 'page.js', 'text/javascript; charset=utf-8'],
  ['/api.js', 'api.js', 'text/javascript; charset=utf-8'],
]
const policy = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ')

export async function loadEmployeeSite({ owner = false } = {}) {
  const files = owner ? [...assets, ['/owner', 'owner.html', 'text/html; charset=utf-8'],
    ['/owner.js', 'owner.js', 'text/javascript; charset=utf-8']] : assets
  // Resolve only packaged assets at startup. The request target never becomes a file path.
  const site = new Map(await Promise.all(files.map(async ([path, name, type]) => {
    const body = await readFile(new URL('../../client/enterprise/' + name, import.meta.url))
    return [path, { body, headers: {
      'Content-Type': type,
      'Content-Length': body.byteLength,
      'Content-Security-Policy': policy,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    } }]
  })))
  return path => site.get(path)
}

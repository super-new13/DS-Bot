import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const statOptions = { bigint: true }
const posix = { skip: process.platform === 'win32' && 'Requires POSIX filesystem fixtures' }
const { O_NOFOLLOW, O_RDONLY, O_NONBLOCK, O_WRONLY, O_CREAT, O_EXCL } = constants

function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code })
}

// Probe only. The worker exclusively owns the fixture tree and its namespace.
function fileInScope(root, path) {
  const parts = path.split('/')
  check(parts.every(part => part && part !== '.' && part !== '..' && !/[\\:]/.test(part) && !part.includes('\0')), 'OUT_OF_SCOPE')
  const device = lstatSync(root, statOptions).dev
  let parent = root
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part)
    const entry = lstatSync(parent, statOptions)
    check(entry.isDirectory() && entry.dev === device, 'OUT_OF_SCOPE')
  }
  return { target: join(parent, parts.at(-1)), device }
}

function metadata(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

function regularOnDevice(stat, device) {
  check(stat.isFile() && stat.nlink === 1n && stat.dev === device, 'OUT_OF_SCOPE')
}

function readScoped(root, path) {
  check(typeof O_NOFOLLOW === 'number' && typeof O_NONBLOCK === 'number', 'UNSUPPORTED_FLAGS')
  const { target, device } = fileInScope(root, path)
  regularOnDevice(lstatSync(target, statOptions), device)
  const fd = openSync(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  try {
    const before = fstatSync(fd, statOptions)
    regularOnDevice(before, device)
    const bytes = readFileSync(fd)
    const after = fstatSync(fd, statOptions)
    const named = lstatSync(target, statOptions)
    regularOnDevice(after, device)
    regularOnDevice(named, device)
    check(metadata(before) === metadata(after) && metadata(after) === metadata(named), 'VERSION_CONFLICT')
    const digest = createHash('sha256').update(bytes).digest('hex')
    return { bytes, version: metadata(after) + ':' + digest }
  } finally {
    closeSync(fd)
  }
}

function createScoped(root, path, bytes) {
  check(typeof O_NOFOLLOW === 'number', 'UNSUPPORTED_FLAGS')
  const { target, device } = fileInScope(root, path)
  const fd = openSync(target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
  try {
    regularOnDevice(fstatSync(fd, statOptions), device)
    writeFileSync(fd, bytes)
  } finally {
    closeSync(fd)
  }
}

function requireVersion(root, path, expected) {
  const { version } = readScoped(root, path)
  check(version === expected, 'VERSION_CONFLICT')
}

function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'dsbot-file-scope-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'business')
  const outside = join(dir, 'outside')
  mkdirSync(root, { mode: 0o700 })
  mkdirSync(join(root, 'notes'), { mode: 0o700 })
  mkdirSync(outside, { mode: 0o700 })
  writeFileSync(join(outside, 'file.txt'), 'outside')
  return { root, outside }
}

const outOfScope = { code: 'OUT_OF_SCOPE' }
const versionConflict = { code: 'VERSION_CONFLICT' }

test('reads an ordinary nested file with a repeatable version', posix, t => {
  const { root } = fixture(t)
  writeFileSync(join(root, 'notes/file.txt'), 'fixture')
  const { bytes, version } = readScoped(root, 'notes/file.txt')
  assert.equal(bytes.toString(), 'fixture')
  assert.doesNotThrow(() => requireVersion(root, 'notes/file.txt', version))
})

test('creates exclusively and leaves an existing file intact', posix, t => {
  const { root } = fixture(t)
  createScoped(root, 'notes/file.txt', 'first')
  assert.throws(() => createScoped(root, 'notes/file.txt', 'second'), { code: 'EEXIST' })
  assert.equal(readScoped(root, 'notes/file.txt').bytes.toString(), 'first')
})

test('rejects old versions after both an in-place edit and a same-content replacement', posix, t => {
  const { root } = fixture(t)
  const target = join(root, 'notes/file.txt')
  writeFileSync(target, 'before')
  const original = readScoped(root, 'notes/file.txt').version
  writeFileSync(target, 'edited')
  assert.throws(() => requireVersion(root, 'notes/file.txt', original), versionConflict)
  const edited = readScoped(root, 'notes/file.txt').version
  writeFileSync(join(root, 'next.txt'), 'edited')
  renameSync(join(root, 'next.txt'), target)
  assert.throws(() => requireVersion(root, 'notes/file.txt', edited), versionConflict)
  assert.equal(readFileSync(target, 'utf8'), 'edited')
})

test('denies absolute paths, parent traversal, and a directory read', posix, t => {
  const { root, outside } = fixture(t)
  for (const path of [join(outside, 'file.txt'), '../outside/file.txt', 'notes/../../outside/file.txt']) {
    assert.throws(() => readScoped(root, path), outOfScope)
    assert.throws(() => createScoped(root, path, 'change'), outOfScope)
  }
  assert.throws(() => createScoped(root, '../outside/new.txt', 'change'), outOfScope)
  assert.throws(() => lstatSync(join(outside, 'new.txt')), { code: 'ENOENT' })
  assert.throws(() => readScoped(root, 'notes'), outOfScope)
  assert.equal(readFileSync(join(outside, 'file.txt'), 'utf8'), 'outside')
})

test('denies symlink targets and ancestors, including links to in-scope files', posix, t => {
  const { root, outside } = fixture(t)
  writeFileSync(join(root, 'notes/internal.txt'), 'inside')
  symlinkSync(join(root, 'notes/internal.txt'), join(root, 'internal-link'))
  symlinkSync(join(outside, 'file.txt'), join(root, 'external-link'))
  symlinkSync(outside, join(root, 'external-dir'))
  symlinkSync(join(outside, 'missing.txt'), join(root, 'dangling'))
  for (const path of ['internal-link', 'external-link', 'external-dir/file.txt', 'dangling']) {
    assert.throws(() => readScoped(root, path), outOfScope)
  }
  assert.throws(() => createScoped(root, 'dangling', 'change'), { code: 'EEXIST' })
  assert.throws(() => createScoped(root, 'external-dir/missing.txt', 'change'), outOfScope)
  assert.throws(() => lstatSync(join(outside, 'missing.txt')), { code: 'ENOENT' })
  assert.equal(readFileSync(join(outside, 'file.txt'), 'utf8'), 'outside')
})

test('denies both names of a multiply linked inode wherever the other link lives', posix, t => {
  const { root, outside } = fixture(t)
  linkSync(join(outside, 'file.txt'), join(root, 'external-alias'))
  writeFileSync(join(root, 'inside.txt'), 'inside')
  linkSync(join(root, 'inside.txt'), join(root, 'internal-alias'))
  for (const path of ['external-alias', 'inside.txt', 'internal-alias']) {
    assert.throws(() => readScoped(root, path), outOfScope)
    assert.throws(() => createScoped(root, path, 'change'), { code: 'EEXIST' })
  }
  assert.equal(readFileSync(join(outside, 'file.txt'), 'utf8'), 'outside')
  assert.equal(readFileSync(join(root, 'inside.txt'), 'utf8'), 'inside')
})

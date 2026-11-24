# Worker business file scope probe

The worker approval probe binds a one-time decision to a live dispatch and its
frozen arguments. This follow-up tests the filesystem checks separately. It
creates a private business root and a sibling directory under a fresh temporary
directory for each case. The test imports no DSH packages. Production employee
file effects remain disabled.

## Run

From the repository root with Node.js 24 on a POSIX host:

```sh
node --test ds-bot/test/enterprise-file-scope.test.js
```

The six tests passed on macOS arm64 with Node.js v24.13.0. They cover nested
regular-file reads, exclusive creation without overwriting existing bytes,
conflicts after an in-place edit or same-content inode replacement, and denial
for absolute paths, traversal, directory reads, symlinks and hard links. The
negative cases check that content outside the business root stays unchanged.

## Filesystem assumptions

The worker owns the root, its ancestors within the fixture, and the files and
directories it operates on. No other process changes those paths during a probe
operation. The root is configured as a trusted absolute path. The filesystem
is local and provides POSIX exclusive creation, descriptor metadata, and
no-follow opens. All directories and files within the scope are on one device.
Device checks alone cannot establish mount isolation. Linux, network or shared
filesystems, and externally writable roots need separate validation.

The probe checks every parent with `lstat` and uses `O_NOFOLLOW` at the leaf.
It checks the open descriptor for a regular file with exactly one link and
checks that the pathname and descriptor still agree after reading. The version
combines device, inode, size, modification and change timestamps, and a hash of
the bytes. Exclusive creation uses `O_CREAT | O_EXCL`. That atomically reserves
a previously unused name. It does not atomically publish the contents or
provide crash durability. An interrupted create could expose a partial file.

## Gap before production

The worker must revalidate employee, session, rule version, operation, path,
expected file version, and approved bytes at the effect boundary. The dispatch
queue serializes per session, so file writers from separate sessions can still
conflict. A production commit must coordinate all writers to the same file.

Pathname checks and final-component no-follow do not pin ancestor directories.
An externally writable directory tree requires a verified, kernel-enforced
resolution boundary or an operating-system-enforced worker-owned namespace.
A version check followed by a write or rename is also two operations. Rename
can atomically publish bytes, but it cannot compare the target with the approved
version as part of the rename. An external writer can make the version stale
between the check and commit. A lock only serializes participants that use it.
Keep effects disabled until the deployment enforces exclusive ownership or
provides a verified conditional commit mechanism for all writers. This test
exercises version detection before a write. It does not establish atomic
replacement, authorization at the effect boundary, or durable audit receipts.

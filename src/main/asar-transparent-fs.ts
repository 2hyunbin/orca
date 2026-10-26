// Electron treats .asar files as directories; unpatched fs prevents recursive rm failures.
// Avoid process.noAsar: other main-process work may load app.asar during a long removal.

import * as nodeFs from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { TreeRemovalFs } from '../shared/bounded-tree-removal'

type FsPromises = typeof nodeFs

let resolvedFs: FsPromises | undefined

function isFsPromises(value: unknown): value is FsPromises {
  return (
    typeof value === 'object' && value !== null && 'rm' in value && typeof value.rm === 'function'
  )
}

function resolveFs(): FsPromises {
  try {
    // Resolve lazily: original-fs exists only in Electron; plain Node’s fs is already unpatched.
    const originalFs: unknown = createRequire(__filename)('original-fs')
    const promises =
      typeof originalFs === 'object' && originalFs !== null && 'promises' in originalFs
        ? originalFs.promises
        : undefined
    return isFsPromises(promises) ? promises : nodeFs
  } catch {
    return nodeFs
  }
}

function unpatchedFs(): FsPromises {
  resolvedFs ??= resolveFs()
  return resolvedFs
}

/** `fs.promises.rm` that sees a `*.asar` as the file it is rather than as a directory. */
export const rm: FsPromises['rm'] = (path, options) => unpatchedFs().rm(path, options)

/** Tree-walk operations that see a `*.asar` as the file it is rather than as a directory. */
export const asarTransparentTreeRemovalFs: TreeRemovalFs = {
  lstat: (path) => unpatchedFs().lstat(path),
  readdir: (path) => unpatchedFs().readdir(path),
  unlink: (path) => unpatchedFs().unlink(path),
  rmdir: (path) => unpatchedFs().rmdir(path),
  chmod: (path, mode) => unpatchedFs().chmod(path, mode)
}

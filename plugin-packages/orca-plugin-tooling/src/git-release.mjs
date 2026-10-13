import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import {
  openAuthorizedRegularFile,
  readNodeFileHandleWithinLimit,
  parsePluginGitTree,
  PLUGIN_GIT_TREE_METADATA_MAX_BYTES
} from '../dist/runtime.mjs'
import { validatePackage } from './package-validation.mjs'

const execute = promisify(execFile)
const MAX_BYTES = 50 * 1024 * 1024

export async function git(root, args, maxBuffer = MAX_BYTES) {
  const result = await execute('git', ['-C', root, ...args], {
    encoding: 'buffer',
    maxBuffer,
    timeout: 30_000,
    windowsHide: true
  })
  return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout)
}

export async function packRelease(root, output, options = {}) {
  const source = await realpath(root)
  const top = await realpath((await git(source, ['rev-parse', '--show-toplevel'])).trim())
  if (source !== top) {
    throw new Error('Release root must be the Git repository root')
  }
  const requested = resolve(output)
  const destination = join(await realpath(dirname(requested)), basename(requested))
  const fromSource = relative(source, destination)
  if (
    !fromSource ||
    (!isAbsolute(fromSource) && fromSource !== '..' && !fromSource.startsWith(`..${sep}`))
  ) {
    throw new Error('Release output must be outside the source repository')
  }
  const commit = (await git(source, ['rev-parse', '--verify', 'HEAD'])).trim()
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new Error('Git did not return an exact commit')
  }
  const entries = parsePluginGitTree(
    Buffer.from(
      await git(
        source,
        ['ls-tree', '-r', '-t', '-l', '-z', '--full-tree', commit],
        PLUGIN_GIT_TREE_METADATA_MAX_BYTES
      )
    )
  )
  await mkdir(destination)
  try {
    let total = 0
    for (const entry of entries) {
      const { path } = entry
      if (entry.kind === 'tree') {
        await mkdir(join(destination, ...path.split('/')))
        continue
      }
      const { object } = entry
      const entryPath = join(source, ...path.split('/'))
      const { handle } = await openAuthorizedRegularFile({
        boundaryPath: source,
        entryPath,
        targetPath: entryPath,
        implicitRootPath: null,
        authorizedRootPaths: []
      })
      let buffer
      try {
        ;({ buffer } = await readNodeFileHandleWithinLimit(handle, MAX_BYTES - total, {
          regularFileOnly: true
        }))
      } finally {
        await handle.close()
      }
      total += buffer.length
      const actual = createHash(object.length === 40 ? 'sha1' : 'sha256')
        .update(`blob ${buffer.length}\0`)
        .update(buffer)
        .digest('hex')
      if (actual !== object) {
        throw new Error(`Tracked file differs from commit ${commit}: ${path}`)
      }
      const target = join(destination, ...path.split('/'))
      await writeFile(target, buffer, { flag: 'wx', mode: entry.executable ? 0o755 : 0o644 })
    }
    const inspection = await validatePackage(destination, { ...options, release: true })
    return { ...inspection, commit, output: destination }
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { runProcess } from '@orca/process-host'
import { withFileTransactionLock } from '../file-transaction-lock'
import {
  canCloneWithApfs,
  cloneWorktreePathWithApfs,
  type ApfsCloneDeps
} from '../ipc/worktree-apfs-clone'
import { gitExecFileAsync } from './runner'
import {
  gitExecOptions,
  resolveWorktreeAddTimeoutMs,
  type GitWorktreeExecOptions
} from './worktree-operation-options'
import { readWorktreeSourceIdentity } from './worktree-source-identity'
import { setWorktreeSourcePermissions } from './worktree-source-permissions'

export async function tryMaterializeSharedWorktreeSource(
  worktreePath: string,
  base: string,
  options: GitWorktreeExecOptions,
  verifyOwnership: () => Promise<void>,
  runtime = { platform: process.platform, env: process.env }
): Promise<boolean> {
  if (
    runtime.env.ORCA_EXPERIMENTAL_SOURCE_SHARING !== '1' ||
    runtime.platform !== 'darwin' ||
    options.wslDistro ||
    runtime.env.GIT_INDEX_FILE ||
    runtime.env.GIT_WORK_TREE ||
    runtime.env.GIT_DIR
  ) {
    return false
  }

  const timeout = options.timeout ?? resolveWorktreeAddTimeoutMs()
  const execOptions = { ...gitExecOptions(worktreePath, options), timeout }
  const deps: ApfsCloneDeps = {
    randomUUID,
    execFileAsync: async (program, args, probeOptions) => {
      const result = await runProcess({
        program,
        args,
        signal: options.signal,
        timeoutMs: probeOptions?.timeout ?? timeout,
        terminationBarrier: true
      })
      if (result.code !== 0 || result.timedOut) {
        throw new Error('Source clone process failed')
      }
      return { stdout: result.stdout, stderr: result.stderr }
    }
  }
  const filesystemCache = new Map()
  try {
    if ((await readdir(worktreePath)).some((name) => name !== '.git')) {
      return false
    }
    await verifyOwnership()
    await gitExecFileAsync(['reset', '--mixed', '-q', base], execOptions)
    const identity = await readWorktreeSourceIdentity(worktreePath, execOptions)
    if (!identity) {
      return false
    }
    const cacheRoot = join(identity.commonDirectory, 'orca-cache', 'tracked-source-v1')
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
    if (!(await canCloneWithApfs(cacheRoot, worktreePath, deps, filesystemCache))) {
      return false
    }

    return await withFileTransactionLock(
      join(cacheRoot, 'maintenance'),
      async () => {
        await verifyOwnership()
        // One seed per repository; this lock also leases it through clone publication.
        for (const name of await readdir(cacheRoot)) {
          if (/^build-[\da-f-]{36}$/.test(name)) {
            await rm(join(cacheRoot, name), { recursive: true, force: true })
          }
        }
        const seed = join(cacheRoot, 'seed')
        const source = join(seed, 'source')
        let valid = false
        try {
          const manifest: unknown = JSON.parse(await readFile(join(seed, 'manifest.json'), 'utf8'))
          valid =
            typeof manifest === 'object' &&
            manifest !== null &&
            'key' in manifest &&
            manifest.key === identity.key &&
            (await lstat(source)).isDirectory()
        } catch {
          // An incomplete or older seed is rebuilt under the same cache lock.
        }
        const staging = join(cacheRoot, `build-${randomUUID()}`)
        const clone = join(worktreePath, `.orca-source-clone-${randomUUID()}`)
        try {
          if (!valid) {
            await rm(seed, { recursive: true, force: true })
            const stagedSource = join(staging, 'source')
            await mkdir(stagedSource, { recursive: true, mode: 0o700 })
            await verifyOwnership()
            await gitExecFileAsync(
              ['checkout-index', '--all', `--prefix=${stagedSource}${sep}`],
              execOptions
            )
            await setWorktreeSourcePermissions(
              stagedSource,
              identity.entries,
              false,
              options.signal
            )
            if (
              (await readWorktreeSourceIdentity(worktreePath, execOptions))?.key !== identity.key
            ) {
              throw new Error('Checkout settings changed while preparing shared source')
            }
            await writeFile(join(staging, 'manifest.json'), JSON.stringify({ key: identity.key }))
            await rename(staging, seed)
          }
          await cloneWorktreePathWithApfs(source, clone, true, deps, filesystemCache)
          await setWorktreeSourcePermissions(clone, identity.entries, true, options.signal)
          if ((await readWorktreeSourceIdentity(worktreePath, execOptions))?.key !== identity.key) {
            throw new Error('Checkout settings changed while cloning shared source')
          }
          for (const name of await readdir(clone)) {
            await verifyOwnership()
            const target = join(worktreePath, name)
            if (
              await lstat(target).then(
                () => true,
                () => false
              )
            ) {
              throw new Error('Prepared worktree changed while cloning shared source')
            }
            await rename(join(clone, name), target)
          }
          await verifyOwnership()
          await gitExecFileAsync(['update-index', '--refresh'], execOptions)
          return true
        } catch (error) {
          await rm(seed, { recursive: true, force: true }).catch(() => {})
          throw error
        } finally {
          await rm(staging, { recursive: true, force: true }).catch(() => {})
          await rm(clone, { recursive: true, force: true }).catch(() => {})
        }
      },
      { retries: 0 }
    )
  } catch {
    options.signal?.throwIfAborted()
    await verifyOwnership()
    return false
  }
}

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { gitExecFileAsync } from './runner'
import { gitExecOptions, type GitWorktreeExecOptions } from './worktree-operation-options'

export type TrackedSourceEntry = { path: string; mode: string }
export type WorktreeSourceIdentity = {
  key: string
  commonDirectory: string
  entries: TrackedSourceEntry[]
}

export async function readWorktreeSourceIdentity(
  worktreePath: string,
  options: GitWorktreeExecOptions
): Promise<WorktreeSourceIdentity | undefined> {
  const execOptions = gitExecOptions(worktreePath, options)
  const settled = await Promise.allSettled([
    gitExecFileAsync(['config', '--null', '--list'], execOptions),
    gitExecFileAsync(['ls-files', '--stage', '-z'], execOptions),
    gitExecFileAsync(['rev-parse', '--verify', 'HEAD'], execOptions),
    gitExecFileAsync(['rev-parse', '--git-common-dir'], execOptions),
    gitExecFileAsync(['--version'], execOptions)
  ])
  const [config, index, head, common, version] = settled.map((result) => {
    if (result.status === 'rejected') {
      throw result.reason
    }
    return result.value
  })
  const commonPath = common.stdout.replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '')
  if (index.stdout.includes('\uFFFD') || !commonPath || commonPath.includes('\n')) {
    return undefined
  }
  const keys = config.stdout.split('\0').map((entry) => entry.split(/\r?\n/)[0].toLowerCase())
  if (keys.includes('core.sparsecheckout') || keys.includes('index.sparse')) {
    return undefined
  }
  // Branch bookkeeping changes after every create without affecting checked-out bytes.
  const checkoutConfig = config.stdout
    .split('\0')
    .filter((entry) => /^(?:core|filter|checkout|extensions|submodule|index)\./i.test(entry))
  const entries: TrackedSourceEntry[] = []
  for (const record of index.stdout.split('\0')) {
    if (!record) {
      continue
    }
    const separator = record.indexOf('\t')
    const [mode, , stage] = record.slice(0, separator).split(' ')
    if (separator === -1 || stage !== '0' || !['100644', '100755', '120000'].includes(mode)) {
      return undefined
    }
    entries.push({ mode, path: record.slice(separator + 1) })
  }
  const attributes = await gitExecFileAsync(['check-attr', '--cached', '--all', '-z', '--stdin'], {
    ...execOptions,
    stdin: entries.map((entry) => `${entry.path}\0`).join('')
  })
  const fields = attributes.stdout.split('\0')
  for (let index = 1; index < fields.length; index += 3) {
    if (fields[index] === 'filter' && !['unset', 'unspecified'].includes(fields[index + 1])) {
      return undefined
    }
  }
  const key = createHash('sha256')
    .update(
      JSON.stringify([head.stdout, checkoutConfig, index.stdout, attributes.stdout, version.stdout])
    )
    .digest('hex')
  return { key, entries, commonDirectory: resolve(worktreePath, commonPath) }
}

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { runEntryRatchet } from './ratchet-baseline.mjs'

// Ratchet on Store writes addressed by a bare repo or worktree id (R4-2). A local row and an SSH
// row can share an id, so an id-only write lands on whichever row matches first. Writes take the
// row's identity instead: `RepoHostTarget` (src/shared/repo-host-identity.ts) or
// `HostWorktreeTarget` (src/shared/worktree/host-qualified-identity.ts). Entries may only go away.

const BASELINE_PATH = 'config/id-only-store-write-baseline.txt'
const COMPOSITION = 'src/main/persistence/loading-store/store-domain-composition.ts'
const ID_PARAM =
  /^(?:id|\w*(?:Repo|Worktree|Workspace|Project|Group)Id|(?:repo|worktree|workspace|project|group)Id)$/
const READ_METHOD = /^(?:get|list|has|peek|read|is|select|find|automation)[A-Z]/
// First parameter, after optional whitespace/newline: `name: string` or `name?: string`.
const METHOD = /^ {2}(?:async )?(\w+)\(\s*(\w+)\??:\s*string\s*[,)]/gm

/** Matches whose id has no host twin, with the reason. Keep each reason true. */
export const NOT_HOST_TWINNED = new Map([
  ['AutomationPersistence.advanceAutomationNextRun', 'automation ids are minted UUIDs'],
  ['AutomationPersistence.deleteAutomation', 'automation ids are minted UUIDs'],
  ['AutomationPersistence.updateAutomation', 'automation ids are minted UUIDs'],
  ['ProjectCollectionOperations.updateProject', 'one Project row spans every host'],
  [
    'RetiredWorktreeNamePersistence.addRetiredWorktreeName',
    'an id-keyed bucket, not a row; re-keying is a non-goal (D7)'
  ],
  [
    'RetiredWorktreeNamePersistence.mergeRetiredWorktreeNames',
    'an id-keyed bucket, not a row; re-keying is a non-goal (D7)'
  ],
  [
    'SparsePresetPersistence.removeSparsePreset',
    'an id-keyed bucket, not a row; re-keying is a non-goal (D7)'
  ],
  ['SshProfileOperations.removeSshTarget', 'the id names the host itself'],
  ['SshProfileOperations.updateSshTarget', 'the id names the host itself']
])

/** `[className, file]` for every operations class the Store mixes in, in composition order. */
export function listStoreOperationClasses(root) {
  const text = fs.readFileSync(path.join(root, COMPOSITION), 'utf8')
  const imports = new Map(
    [...text.matchAll(/^import \{ (\w+) \} from '([^']+)'/gm)].map((m) => [m[1], m[2]])
  )
  const list = /STORE_DOMAIN_OPERATION_CLASSES = \[([\s\S]*?)\]/.exec(text)
  if (!list) {
    throw new Error(`${COMPOSITION}: STORE_DOMAIN_OPERATION_CLASSES not found`)
  }
  return list[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const specifier = imports.get(name)
      if (!specifier) {
        throw new Error(`${COMPOSITION}: no import for ${name}`)
      }
      return [name, path.posix.join(path.posix.dirname(COMPOSITION), `${specifier}.ts`)]
    })
}

/** Public mutating methods of `className` in `source` whose first parameter is a bare id string. */
export function findIdOnlyWrites(className, source) {
  const start = source.indexOf(`export class ${className}`)
  if (start === -1) {
    return []
  }
  const rest = source.slice(start)
  const end = rest.search(/^\}/m)
  const body = end < 0 ? rest : rest.slice(0, end)
  const found = []
  for (const match of body.matchAll(METHOD)) {
    const [, method, param] = match
    if (!READ_METHOD.test(method) && ID_PARAM.test(param)) {
      found.push(`${className}.${method}`)
    }
  }
  return found
}

export function collectIdOnlyStoreWrites(root = process.cwd()) {
  const entries = []
  for (const [className, rel] of listStoreOperationClasses(root)) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8')
    entries.push(...findIdOnlyWrites(className, source).filter((e) => !NOT_HOST_TWINNED.has(e)))
  }
  return [...new Set(entries)].sort()
}

export function main(root = process.cwd(), arg = undefined) {
  return runEntryRatchet(
    {
      name: 'id-only-store-write',
      baselinePath: BASELINE_PATH,
      header: [
        '# Store writes whose first parameter is a bare repo or worktree id (R4-2), as Class.method.',
        '# This is a RATCHET: entries may only be REMOVED. Take RepoHostTarget or HostWorktreeTarget.',
        '# Prune after a fix: pnpm check:id-only-store-write-ratchet --prune'
      ],
      collect: collectIdOnlyStoreWrites,
      fix: [
        'Take the row, not its id: RepoHostTarget (src/shared/repo-host-identity.ts) for repo rows,',
        'HostWorktreeTarget (src/shared/worktree/host-qualified-identity.ts) for worktree rows. A caller',
        'with only an id resolves the row where its host is known (RPC selector, IPC hostId).'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}

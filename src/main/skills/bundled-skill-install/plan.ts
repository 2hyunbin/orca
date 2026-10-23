import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  BundledSkillCleanup,
  BundledSkillObserved,
  BundledSkillOp,
  BundledSkillPlan,
  BundledSkillPlanEntry
} from '../../../shared/bundled-skill-plan'
import { skillDeleteJournalPath } from '../skill-delete/recovery'
import { skillInstallReceiptPath } from '../skill-install-provenance'
import { skillInstallJournalPath } from '../skill-install-recovery'
import { skillPlacementJournalPath } from '../skill-placement-recovery-journal'
import { skillRemovalJournalPath } from '../skill-remove-recovery'
import type { BundledSkillSource } from './bundled-skill-sources'
import {
  bundledSkillTextDigest,
  classifyBundledSkillPath,
  type BundledSkillFolderClass
} from './classify'
import type { BundledSkillFilesystem } from './filesystem'
import { bundledSkillSiblingKind } from './swap'
import {
  bundledSkillPathKey,
  resolveBundledSkillRealPath,
  resolveBundledSkillTargets,
  type BundledSkillTargetRequest,
  type BundledSkillTargetRoot
} from './targets'

export type BundledSkillPlanInput = BundledSkillTargetRequest & {
  /** Bundled skill names; every bundled skill when omitted. */
  names?: readonly string[]
  /** Target paths the user chose to Replace (`--force`). */
  force?: readonly string[]
  /** `<userData>/skill-installs`, where cloud installs keep receipts and journals. */
  stateDirectory: string
  filesystem: BundledSkillFilesystem
  sources: readonly BundledSkillSource[]
}

export type ResolvedBundledSkillPlan = {
  plan: BundledSkillPlan
  roots: BundledSkillTargetRoot[]
}

type SkillContext = {
  input: BundledSkillPlanInput
  source: BundledSkillSource
  digest: string
  force: Set<string>
}

type SharedTarget = { path: string; realPath: string; current: boolean }

const WRITES_SHARED_CURRENT = new Set<BundledSkillOp['kind']>([
  'keep',
  'write',
  'update',
  'replace'
])

/** One canonical serialisation: the plan is built by one code path, so key order is fixed. */
export function bundledSkillDigestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function sameBundledSkillObserved(
  left: BundledSkillObserved,
  right: BundledSkillObserved
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function anyFileExists(paths: readonly string[]): Promise<boolean> {
  const found = await Promise.all(
    paths.map((path) =>
      lstat(path).then(
        () => true,
        () => false
      )
    )
  )
  return found.includes(true)
}

/** Cloud installs key state on the realpath'd destination, so check both spellings. */
function stateKeysFor(path: string, realPath: string): string[] {
  return [...new Set([resolve(path), realPath])]
}

function hasPendingCloudTransaction(stateDirectory: string, keys: readonly string[]) {
  return anyFileExists(
    keys.flatMap((key) => [
      skillInstallJournalPath(stateDirectory, key),
      skillPlacementJournalPath(stateDirectory, key),
      skillRemovalJournalPath(stateDirectory, key),
      skillDeleteJournalPath(stateDirectory, key)
    ])
  )
}

function hasCloudReceipt(stateDirectory: string, keys: readonly string[]) {
  return anyFileExists(keys.map((key) => skillInstallReceiptPath(stateDirectory, key)))
}

async function linkPointsAt(
  filesystem: BundledSkillFilesystem,
  path: string,
  rawTarget: string,
  realPath: string
): Promise<boolean> {
  const resolved =
    (await filesystem.realpath(path)) ??
    resolve(await resolveBundledSkillRealPath(filesystem, dirname(path)), rawTarget)
  return bundledSkillPathKey(resolved) === bundledSkillPathKey(realPath)
}

async function recoverySiblings(
  context: SkillContext,
  root: BundledSkillTargetRoot,
  targetIsAbsent: boolean
): Promise<{ restoreFrom?: BundledSkillOp['restoreFrom']; cleanup: BundledSkillCleanup[] }> {
  const { filesystem } = context.input
  const listing = (await filesystem.listEntries(root.path)) ?? []
  const cleanup: BundledSkillCleanup[] = []
  const olds: { path: string; observed: BundledSkillObserved; folderClass: string }[] = []
  for (const entry of [...listing].sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const kind = bundledSkillSiblingKind(context.source.name, entry.name)
    const path = join(root.path, entry.name)
    if (!kind) {
      continue
    }
    const classified = await classifyBundledSkillPath(
      filesystem,
      path,
      context.source,
      context.digest,
      true
    )
    if (classified.observed.kind === 'unreadable') {
      continue
    }
    if (kind === 'stage') {
      cleanup.push({ path, action: 'delete', observed: classified.observed })
    } else {
      olds.push({ path, ...classified })
    }
  }
  const restore = targetIsAbsent ? olds.shift() : undefined
  for (const old of olds) {
    const released = old.folderClass === 'current' || old.folderClass === 'released'
    cleanup.push({ path: old.path, action: released ? 'delete' : 'backup', observed: old.observed })
  }
  return {
    ...(restore ? { restoreFrom: { path: restore.path, observed: restore.observed } } : {}),
    cleanup
  }
}

async function planTarget(
  context: SkillContext,
  root: BundledSkillTargetRoot,
  shared: SharedTarget | null
): Promise<BundledSkillOp> {
  const { filesystem, stateDirectory } = context.input
  const path = join(root.path, context.source.name)
  const realPath = join(root.realPath, context.source.name)
  const stateKeys = stateKeysFor(path, realPath)
  const classified = await classifyBundledSkillPath(
    filesystem,
    path,
    context.source,
    context.digest,
    context.force.has(bundledSkillPathKey(path))
  )
  const { observed } = classified
  let folderClass: BundledSkillFolderClass = classified.folderClass
  // Why: a same-named skill installed through cloud sharing is that package, not Orca's copy.
  // A `current` one is left as `keep`, so a Replace of a cloud copy settles instead of looping.
  if (
    (folderClass === 'released' || folderClass === 'edited') &&
    (await hasCloudReceipt(stateDirectory, stateKeys))
  ) {
    folderClass = 'other'
  }
  const { restoreFrom, cleanup } = await recoverySiblings(context, root, folderClass === 'absent')
  const base = { path, role: root.role, agents: root.agents, observed }
  const leave = (reason: NonNullable<BundledSkillOp['reason']>, replaceable: boolean) =>
    ({ ...base, kind: 'leave', reason, replaceable, cleanup }) satisfies BundledSkillOp
  const files = (kind: 'write' | 'update' | 'copy' | 'replace'): BundledSkillOp => ({
    ...base,
    kind,
    content: 'files',
    cleanup
  })
  // Why `requires`: a link to a shared copy that failed to land would point at nothing.
  const linkToShared = (kind: 'link' | 'replace', target: SharedTarget): BundledSkillOp => ({
    ...base,
    kind,
    content: 'link',
    linkTarget: target.path,
    requires: target.path,
    cleanup
  })

  const decide = async (): Promise<BundledSkillOp> => {
    if (observed.kind === 'unreadable') {
      return leave('unreadable', false)
    }
    if (restoreFrom) {
      return { ...base, kind: 'restore', restoreFrom, cleanup }
    }
    switch (folderClass) {
      case 'current':
        return { ...base, kind: 'keep', cleanup }
      case 'released':
        return files('update')
      case 'absent':
        if (!shared) {
          return files('write')
        }
        if (!shared.current) {
          return leave('shared-not-current', false)
        }
        return filesystem.supportsLinks ? linkToShared('link', shared) : files('copy')
      case 'edited':
      case 'other':
        break
    }
    if (
      shared &&
      observed.kind === 'link' &&
      (await linkPointsAt(filesystem, path, observed.target, shared.realPath))
    ) {
      return shared.current
        ? { ...base, kind: 'keep', cleanup }
        : leave('shared-not-current', false)
    }
    if (!context.force.has(bundledSkillPathKey(path))) {
      return leave(folderClass === 'edited' ? 'edited' : 'other', true)
    }
    return shared?.current && filesystem.supportsLinks
      ? linkToShared('replace', shared)
      : files('replace')
  }

  const op = await decide()
  const writes = op.kind !== 'keep' && op.kind !== 'leave'
  if (!writes && op.cleanup.length === 0) {
    return op
  }
  const blocked = (await hasPendingCloudTransaction(stateDirectory, stateKeys))
    ? 'busy'
    : (await filesystem.canWrite(root.realPath))
      ? null
      : 'unwritable'
  if (!blocked) {
    return op
  }
  return { ...(writes ? leave(blocked, false) : op), cleanup: [] }
}

async function planSkill(
  input: BundledSkillPlanInput,
  roots: readonly BundledSkillTargetRoot[],
  source: BundledSkillSource
): Promise<BundledSkillPlanEntry> {
  const context: SkillContext = {
    input,
    source,
    digest: bundledSkillTextDigest(Buffer.from(source.text, 'utf8')),
    force: new Set((input.force ?? []).map(bundledSkillPathKey))
  }
  let shared: SharedTarget | null = null
  const ops: BundledSkillOp[] = []
  for (const root of roots) {
    const op = await planTarget(context, root, shared)
    ops.push(op)
    if (root.role === 'shared') {
      shared = {
        path: op.path,
        realPath: join(root.realPath, source.name),
        current: WRITES_SHARED_CURRENT.has(op.kind)
      }
    }
  }
  return { name: source.name, digest: context.digest, ops }
}

/**
 * The only code that decides what a bundled-skill install does. Preview and execute both come
 * through here, and execute applies a plan only while it still hashes to what was previewed.
 */
export async function buildBundledSkillPlan(
  input: BundledSkillPlanInput
): Promise<ResolvedBundledSkillPlan> {
  const roots = await resolveBundledSkillTargets(input, input.filesystem)
  const selected = input.names
    ? input.names.map((name) => {
        const source = input.sources.find((candidate) => candidate.name === name)
        if (!source) {
          throw new Error(`bundled-skill-unknown: ${name}`)
        }
        return source
      })
    : input.sources
  const skills: BundledSkillPlanEntry[] = []
  for (const source of selected) {
    skills.push(await planSkill(input, roots, source))
  }
  return {
    plan: { scope: input.destination.scope, skills, planDigest: bundledSkillDigestOf(skills) },
    roots
  }
}

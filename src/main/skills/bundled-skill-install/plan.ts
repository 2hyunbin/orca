import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type {
  BundledSkillCleanup,
  BundledSkillObserved,
  BundledSkillOp,
  BundledSkillPlan,
  BundledSkillPlanEntry
} from '../../../shared/bundled-skill-plan'
import type { BundledSkillSource } from './bundled-skill-sources'
import { hasCloudReceipt, hasPendingCloudTransaction, stateKeysFor } from './cloud-state'
import {
  bundledSkillTextDigest,
  classifyBundledSkillObservation,
  type BundledSkillFolderClass
} from './classify'
import type { BundledSkillFilesystem } from './filesystem'
import { canWriteOnce, observeTargets, type PlanPass } from './plan-observations'
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
  /** Target paths the user chose to Replace; `all` is `--force`, every replaceable one. */
  force?: readonly string[] | 'all'
  /**
   * Update: plan only locations that already hold something, so an update never spreads a
   * skill to another agent; a skill with no copy of Orca's anywhere is skipped.
   */
  installedOnly?: boolean
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
  pass: PlanPass
  source: BundledSkillSource
  digest: string
  force: Set<string> | 'all'
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

async function linkPointsAt(
  filesystem: BundledSkillFilesystem,
  path: string,
  link: { rawTarget: string; realPath: string | null },
  realPath: string
): Promise<boolean> {
  const resolved =
    link.realPath ??
    resolve(await resolveBundledSkillRealPath(filesystem, dirname(path)), link.rawTarget)
  return bundledSkillPathKey(resolved) === bundledSkillPathKey(realPath)
}

async function recoverySiblings(
  context: SkillContext,
  root: BundledSkillTargetRoot,
  targetIsAbsent: boolean
): Promise<{ restoreFrom?: BundledSkillOp['restoreFrom']; cleanup: BundledSkillCleanup[] }> {
  const listing = context.pass.observations.get(root.realPath)?.entries ?? []
  const cleanup: BundledSkillCleanup[] = []
  const olds: { path: string; observed: BundledSkillObserved; folderClass: string }[] = []
  for (const entry of [...listing].sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const kind = bundledSkillSiblingKind(context.source.name, entry.name)
    const path = join(root.path, entry.name)
    if (!kind) {
      continue
    }
    const classified = classifyBundledSkillObservation(
      context.pass.observations.get(path),
      context.source,
      context.digest
    )
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

type PlannedTarget = { op: BundledSkillOp; holdsOrcaCopy: boolean }

const ORCA_COPY_CLASSES = new Set<BundledSkillFolderClass>(['current', 'released', 'edited'])

async function planTarget(
  context: SkillContext,
  root: BundledSkillTargetRoot,
  shared: SharedTarget | null
): Promise<PlannedTarget> {
  const { filesystem, stateDirectory } = context.input
  const path = join(root.path, context.source.name)
  const realPath = join(root.realPath, context.source.name)
  const stateKeys = stateKeysFor(path, realPath)
  const classified = classifyBundledSkillObservation(
    context.pass.observations.get(path),
    context.source,
    context.digest
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
      (await linkPointsAt(
        filesystem,
        path,
        { rawTarget: observed.target, realPath: classified.linkRealPath ?? null },
        shared.realPath
      ))
    ) {
      return shared.current
        ? { ...base, kind: 'keep', cleanup }
        : leave('shared-not-current', false)
    }
    if (context.force !== 'all' && !context.force.has(bundledSkillPathKey(path))) {
      return leave(folderClass === 'edited' ? 'edited' : 'other', true)
    }
    return shared?.current && filesystem.supportsLinks
      ? linkToShared('replace', shared)
      : files('replace')
  }

  const holdsOrcaCopy = Boolean(restoreFrom) || ORCA_COPY_CLASSES.has(folderClass)
  const op = await decide()
  const writes = op.kind !== 'keep' && op.kind !== 'leave'
  if (!writes && op.cleanup.length === 0) {
    return { op, holdsOrcaCopy }
  }
  const blocked = (await hasPendingCloudTransaction(stateDirectory, stateKeys))
    ? 'busy'
    : (await canWriteOnce(context.pass, context.input.filesystem, root.realPath))
      ? null
      : 'unwritable'
  if (!blocked) {
    return { op, holdsOrcaCopy }
  }
  return { op: { ...(writes ? leave(blocked, false) : op), cleanup: [] }, holdsOrcaCopy }
}

async function planSkill(
  input: BundledSkillPlanInput,
  pass: PlanPass,
  roots: readonly BundledSkillTargetRoot[],
  source: BundledSkillSource
): Promise<BundledSkillPlanEntry | null> {
  const context: SkillContext = {
    input,
    pass,
    source,
    digest: bundledSkillTextDigest(Buffer.from(source.text, 'utf8')),
    force: input.force === 'all' ? 'all' : new Set((input.force ?? []).map(bundledSkillPathKey))
  }
  const [sharedRoot, ...agentRoots] = roots
  const sharedTarget = await planTarget(context, sharedRoot, null)
  const shared: SharedTarget = {
    path: sharedTarget.op.path,
    realPath: join(sharedRoot.realPath, source.name),
    current: WRITES_SHARED_CURRENT.has(sharedTarget.op.kind)
  }
  const planAgents = async (target: SharedTarget) => {
    const agents: PlannedTarget[] = []
    for (const root of agentRoots) {
      agents.push(await planTarget(context, root, target))
    }
    return agents
  }
  let agents = await planAgents(shared)
  if (!input.installedOnly) {
    return {
      name: source.name,
      digest: context.digest,
      ops: [sharedTarget, ...agents].map((target) => target.op)
    }
  }
  if (![sharedTarget, ...agents].some((target) => target.holdsOrcaCopy)) {
    return null
  }
  // Why: an empty shared slot is written only to repair an agent's existing link to it; any
  // other plan (a Replace among them) must not add the skill there, so it plans without it.
  const keepShared =
    isPresent(sharedTarget.op) ||
    agents.some((target) => target.op.kind === 'keep' && target.op.observed.kind === 'link')
  if (!keepShared && shared.current) {
    agents = await planAgents({ ...shared, current: false })
  }
  const ops = [...(keepShared ? [sharedTarget] : []), ...agents]
    .filter((target, index) => isPresent(target.op) || (keepShared && index === 0))
    .map((target) => target.op)
  return { name: source.name, digest: context.digest, ops }
}

/** Something is at the path, or an interrupted swap left a sibling to settle there. */
function isPresent(op: BundledSkillOp): boolean {
  return op.observed.kind !== 'absent' || op.restoreFrom !== undefined || op.cleanup.length > 0
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
  const pass = await observeTargets(input.filesystem, roots, selected)
  const skills: BundledSkillPlanEntry[] = []
  for (const source of selected) {
    const entry = await planSkill(input, pass, roots, source)
    if (entry) {
      skills.push(entry)
    }
  }
  return {
    plan: {
      scope: input.destination.scope,
      homeDirectory: input.destination.homeDirectory,
      skills,
      planDigest: bundledSkillDigestOf(skills)
    },
    roots
  }
}

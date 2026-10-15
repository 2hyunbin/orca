import { lstat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isSkillInstallProviderId } from '../../shared/skill-install-providers'
import {
  bundledInstallContext,
  prepareBundledSkill,
  requireBundledPackages,
  type BundledOrcaSkillInstallInput,
  type PreparedBundledSkill
} from './bundled-orca-skill-install'
import { nativeSkillInstallFilesystem } from './skill-install-filesystem'
import { inspectSkillCanonicalState, type SkillCanonicalState } from './skill-install-planner'
import { skillInstallReplacementAllowed } from './skill-install-transaction-result'
import { resolveSkillProviderDestinations } from './skill-provider-destinations'

export type BundledOrcaSkillPlacementPlan = {
  path: string
  /** link: create one; replace: rewrite an owned copy; keep: already current; skip: not ours. */
  action: 'link' | 'replace' | 'keep' | 'skip'
}

export type BundledOrcaSkillPlan = {
  name: string
  canonicalPath: string
  state: SkillCanonicalState['kind']
  /** Whether a run would write the shared copy. */
  replacesCanonical: boolean
  placements: BundledOrcaSkillPlacementPlan[]
  /** Whether a run would change anything on disk for this skill. */
  willWrite: boolean
}

function normalizedPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

async function planPlacement(
  prepared: PreparedBundledSkill,
  destinationPath: string
): Promise<BundledOrcaSkillPlacementPlan['action']> {
  const stat = await lstat(destinationPath).catch(() => null)
  if (!stat) {
    return 'link'
  }
  const [resolvedDestination, resolvedCanonical] = await Promise.all([
    realpath(destinationPath).catch(() => null),
    realpath(prepared.canonicalPath).catch(() => prepared.canonicalPath)
  ])
  if (
    resolvedDestination &&
    normalizedPath(resolvedDestination) === normalizedPath(resolvedCanonical)
  ) {
    return 'keep'
  }
  if (stat.isSymbolicLink()) {
    return 'skip'
  }
  const filesystem = prepared.request.filesystem ?? nativeSkillInstallFilesystem
  const observed = await filesystem
    .observeSkill(destinationPath, prepared.manifest.files)
    .catch(() => null)
  if (!observed) {
    return 'skip'
  }
  if (observed.observedDigest === prepared.manifest.packageDigest) {
    return 'keep'
  }
  const ownedDigests = [
    ...(prepared.local.adoptableDigests ?? []),
    ...(prepared.receipt ? [prepared.receipt.packageDigest] : [])
  ]
  return ownedDigests.includes(observed.observedDigest) ? 'replace' : 'skip'
}

async function planBundledSkill(prepared: PreparedBundledSkill): Promise<BundledOrcaSkillPlan> {
  const state = await inspectSkillCanonicalState({
    canonicalPath: prepared.canonicalPath,
    manifest: prepared.manifest,
    receipt: prepared.receipt,
    filesystem: prepared.request.filesystem
  })
  const replacesCanonical =
    state.kind !== 'unchanged' &&
    skillInstallReplacementAllowed(state, prepared.local) &&
    // Same refusal the transaction makes before it would move an unreadable copy aside.
    (state.kind === 'missing' || ('digest' in state && state.digest !== undefined))
  const canonicalReady = state.kind === 'unchanged' || replacesCanonical
  const { request } = prepared
  const destinations = canonicalReady
    ? resolveSkillProviderDestinations({
        scope: request.scope,
        homeDirectory: request.homeDirectory,
        workspaceDirectory: request.workspaceDirectory,
        detectedProviders: request.detectedProviders.filter(isSkillInstallProviderId),
        providerRootOverrides:
          request.scope === 'global' ? request.providerRootOverrides : undefined
      }).filter((destination) => !destination.readsCanonicalRoot)
    : []
  const placements = await Promise.all(
    destinations.map(async (destination) => {
      const path = join(destination.rootPath, prepared.entry.name)
      return { path, action: await planPlacement(prepared, path) }
    })
  )
  return {
    name: prepared.entry.name,
    canonicalPath: prepared.canonicalPath,
    state: state.kind,
    replacesCanonical,
    placements,
    willWrite:
      replacesCanonical ||
      placements.some((placement) => placement.action === 'link' || placement.action === 'replace')
  }
}

/** What a run would do, read without writing anything. */
export async function planBundledOrcaSkills(
  names: readonly string[],
  input: BundledOrcaSkillInstallInput
): Promise<BundledOrcaSkillPlan[]> {
  const entries = requireBundledPackages(names)
  const context = await bundledInstallContext(input)
  return Promise.all(
    entries.map(async (entry) => planBundledSkill(await prepareBundledSkill(context, entry)))
  )
}

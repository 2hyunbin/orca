import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  BUNDLED_ORCA_SKILL_PACKAGES,
  type BundledOrcaSkillPackage
} from '../../shared/bundled-orca-skill-packages'
import type { SkillInstallResult } from '../../shared/skill-install-contract'
import {
  computeSkillPackageDigest,
  parseSkillPackageManifest,
  type SkillPackageFile,
  type SkillPackageManifestV1
} from '../../shared/skill-package-manifest'
import { isOrcaSkillLockSource } from '../../shared/skill-freshness'
import {
  installSharedExtractedSkill,
  skillInstallLocalInput,
  type SkillInstallServiceInput
} from './skill-install-service'
import { inspectSkillCanonicalState, type SkillCanonicalState } from './skill-install-planner'
import {
  BUNDLED_ORCA_SKILL_PACKAGE_ID_PREFIX,
  readSkillInstallReceipt
} from './skill-install-provenance'
import {
  beginSkillExtractionRecovery,
  finishSkillExtractionRecovery
} from './skill-extraction-recovery'
import { nativeSkillInstallFilesystem } from './skill-install-filesystem'
import { skillInstallFailureFromError } from './skill-install-operation-error'
import { skillInstallPathExists } from './skill-install-recovery'
import { readProjectSkillLockSources, readSkillLockSources } from './skill-lock-sources'

export function findBundledOrcaSkillPackage(name: string): BundledOrcaSkillPackage | null {
  return BUNDLED_ORCA_SKILL_PACKAGES.find((entry) => entry.name === name) ?? null
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function bundledOrcaSkillManifest(entry: BundledOrcaSkillPackage): SkillPackageManifestV1 {
  // Why text identity equals the exact hash: the generator stores every file LF-normalized.
  const files: SkillPackageFile[] = entry.files.map((file) => {
    const bytes = Buffer.from(file.text, 'utf8')
    const digest = sha256(bytes)
    return {
      path: file.path,
      size: bytes.length,
      executable: false,
      classification: 'text',
      sha256: digest,
      identitySha256: digest
    }
  })
  const packageDigest = computeSkillPackageDigest(files)
  return parseSkillPackageManifest({
    schemaVersion: 1,
    packageId: `${BUNDLED_ORCA_SKILL_PACKAGE_ID_PREFIX}${entry.name}`,
    versionId: packageDigest,
    name: entry.name,
    description: '',
    createdAt: new Date(0).toISOString(),
    files,
    packageDigest
  })
}

export type BundledOrcaSkillInstallInput = Omit<
  SkillInstallServiceInput,
  'operationId' | 'archivePath' | 'adoptableDigests' | 'conflictResolution'
> & {
  /** Replaces copies with local changes too; never a link or a colliding name. */
  discardLocalChanges?: boolean
  /** The skills.sh lock at this scope. Read only: Orca never writes it. */
  readLockSources?: () => Promise<ReadonlyMap<string, string>>
}

type BundledInstallContext = {
  input: BundledOrcaSkillInstallInput
  lockSources: ReadonlyMap<string, string>
}

async function bundledInstallContext(
  input: BundledOrcaSkillInstallInput
): Promise<BundledInstallContext> {
  const readLockSources =
    input.readLockSources ??
    (() =>
      input.scope === 'workspace' && input.workspaceDirectory
        ? readProjectSkillLockSources(input.workspaceDirectory)
        : readSkillLockSources())
  return { input, lockSources: await readLockSources() }
}

function serviceInput(
  context: BundledInstallContext,
  manifest: SkillPackageManifestV1,
  adoptableDigests: readonly string[] | undefined
): SkillInstallServiceInput {
  return {
    ...context.input,
    operationId: randomUUID(),
    // Why empty: the package is staged from embedded bytes, so no archive is read.
    archivePath: '',
    expectedPackageDigest: manifest.packageDigest,
    adoptableDigests,
    ...(context.input.discardLocalChanges
      ? { conflictResolution: 'replace-and-discard-local' as const }
      : {})
  }
}

/**
 * An earlier Orca version is ours to replace when the skills.sh lock or Orca's own receipt
 * says Orca installed it. Any other bytes are the user's and stay a conflict.
 */
async function adoptableDigests(
  context: BundledInstallContext,
  entry: BundledOrcaSkillPackage,
  canonicalPath: string,
  stateDirectory: string
): Promise<readonly string[] | undefined> {
  if (isOrcaSkillLockSource(context.lockSources.get(entry.name) ?? null)) {
    return entry.releasedDigests
  }
  const receipt = await readSkillInstallReceipt(stateDirectory, canonicalPath)
  return receipt && receipt.packageId.startsWith(BUNDLED_ORCA_SKILL_PACKAGE_ID_PREFIX)
    ? entry.releasedDigests
    : undefined
}

async function prepareBundledSkill(context: BundledInstallContext, entry: BundledOrcaSkillPackage) {
  const manifest = bundledOrcaSkillManifest(entry)
  const draft = skillInstallLocalInput(serviceInput(context, manifest, undefined))
  const canonicalPath = join(draft.destinationRoot, entry.name)
  const adoptable = await adoptableDigests(context, entry, canonicalPath, draft.stateDirectory)
  return { manifest, canonicalPath, request: serviceInput(context, manifest, adoptable) }
}

async function installBundledSkill(
  context: BundledInstallContext,
  entry: BundledOrcaSkillPackage
): Promise<SkillInstallResult> {
  const { manifest, canonicalPath, request } = await prepareBundledSkill(context, entry)
  const local = skillInstallLocalInput(request)
  // Why: an adopted copy has no receipt, which the installer would report as a fresh install.
  const replacing = await skillInstallPathExists(canonicalPath)
  const filesystem = request.filesystem ?? nativeSkillInstallFilesystem
  await mkdir(local.destinationRoot, { recursive: true })
  const recovery = await beginSkillExtractionRecovery(
    local.stateDirectory,
    local.destinationRoot,
    request.wslDistro
  )
  try {
    const skillRoot = join(recovery.extractionPath, 'skill')
    for (const file of entry.files) {
      const target = join(skillRoot, ...file.path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.text, 'utf8')
    }
    await request.filesystem?.prepareExtractedSkill(skillRoot, manifest)
    const result = await installSharedExtractedSkill(request, {
      extractionPath: recovery.extractionPath,
      manifest,
      archiveSha256: manifest.packageDigest
    })
    return replacing && result.status === 'installed' ? { ...result, status: 'updated' } : result
  } finally {
    await finishSkillExtractionRecovery(local.stateDirectory, recovery, filesystem)
  }
}

function failedResult(entry: BundledOrcaSkillPackage, error: unknown): SkillInstallResult {
  const failure = skillInstallFailureFromError(error)
  const code = failure?.code ?? 'skill-install-bundled-failed'
  return {
    operationId: randomUUID(),
    status: failure?.category === 'cancelled' ? 'cancelled' : 'failed',
    name: entry.name,
    packageDigest: bundledOrcaSkillManifest(entry).packageDigest,
    placements: [],
    errorCategory: code,
    failure: failure ?? { category: 'filesystem', code, retryable: true }
  }
}

function requireBundledPackages(names: readonly string[]): BundledOrcaSkillPackage[] {
  return names.map((name) => {
    const entry = findBundledOrcaSkillPackage(name)
    if (!entry) {
      throw new Error(`skill-install-bundled-unknown:${name}`)
    }
    return entry
  })
}

/** Installs or updates Orca's own skills from the bytes this build ships. */
export async function installBundledOrcaSkills(
  names: readonly string[],
  input: BundledOrcaSkillInstallInput
): Promise<SkillInstallResult[]> {
  const entries = requireBundledPackages(names)
  const context = await bundledInstallContext(input)
  const results: SkillInstallResult[] = []
  // Why sequential: each skill takes its own transaction lock, and one failure must not
  // abandon the rest.
  for (const entry of entries) {
    results.push(
      await installBundledSkill(context, entry).catch((error) => failedResult(entry, error))
    )
  }
  return results
}

export type BundledOrcaSkillPlan = {
  name: string
  canonicalPath: string
  state: SkillCanonicalState['kind']
  /** Whether a run would write this skill; false for up-to-date and conflicting copies. */
  willWrite: boolean
}

/** What a run would do, read without writing anything. */
export async function planBundledOrcaSkills(
  names: readonly string[],
  input: BundledOrcaSkillInstallInput
): Promise<BundledOrcaSkillPlan[]> {
  const entries = requireBundledPackages(names)
  const context = await bundledInstallContext(input)
  return Promise.all(
    entries.map(async (entry) => {
      const { manifest, canonicalPath, request } = await prepareBundledSkill(context, entry)
      const local = skillInstallLocalInput(request)
      const state = await inspectSkillCanonicalState({
        canonicalPath,
        manifest,
        receipt: await readSkillInstallReceipt(local.stateDirectory, canonicalPath),
        filesystem: request.filesystem
      })
      const adoptable =
        (state.kind === 'modified' || state.kind === 'unowned') &&
        state.digest !== undefined &&
        (request.adoptableDigests?.includes(state.digest) === true ||
          request.conflictResolution === 'replace-and-discard-local')
      return {
        name: entry.name,
        canonicalPath,
        state: state.kind,
        willWrite: state.kind === 'missing' || state.kind === 'clean-update' || adoptable
      }
    })
  )
}

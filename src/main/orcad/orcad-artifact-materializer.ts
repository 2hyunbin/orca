import { collectOrcadControlHostResources } from './orcad-control-host-resources'
import {
  readOrcadTemplateManifest,
  verifyOrcadTemplateTarget,
  type OrcadTemplateManifest
} from './orcad-deployment-template'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import {
  ORCAD_TEMPLATE_TARGETS_DIR,
  ORCAD_VERSION,
  ORCAD_VERSION_FILENAME,
  orcadArtifactFilenames,
  orcadTemplateTargetFilenames
} from '../../shared/orcad-artifacts'
import type { NodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { findOrcadCachePath } from '../node-runtime/orcad-cache-path'
import {
  fileSha256,
  type PinnedRuntimeMaterializeOptions
} from '../node-runtime/pinned-runtime-materializer'
import { OrcadArtifactsUnavailableError, OrcadHostUnsupportedError } from './orcad-host-unavailable'

type MaterializeOptions = PinnedRuntimeMaterializeOptions & {
  templateDir?: string
  cacheRoot?: string
  includeDeploymentTemplate?: boolean
}

const materializations = new Map<string, Promise<string>>()
// Slots handed out this session: a deploy may still be reading one, so cache retention keeps them.
const materializedVersions = new Set<string>()

export function materializedOrcadArtifactVersions(): ReadonlySet<string> {
  return materializedVersions
}

/** A verified slot directory for `target`; its runtime is referenced, not included (design D2). */
export async function materializeOrcadArtifact(
  target: NodeRuntimeTarget,
  options: MaterializeOptions = {}
): Promise<string> {
  options.signal?.throwIfAborted()
  const templateDir = options.templateDir ?? resolveOrcadTemplateDir()
  const cacheRoot =
    options.cacheRoot ?? join(getAppEnvironment().getPath('userData'), 'orcad-artifacts')
  const key = `${templateDir}\0${cacheRoot}\0${target}\0${options.includeDeploymentTemplate === true}`
  const existing = materializations.get(key)
  if (existing) {
    return waitForPromiseWithSignal(existing, options.signal)
  }
  // Cancellation detaches one caller; the bounded cache fill still serves other deployments.
  const pending = assembleOrcadArtifact({
    templateDir,
    cacheRoot,
    target,
    includeDeploymentTemplate: options.includeDeploymentTemplate
  }).finally(() => materializations.delete(key))
  materializations.set(key, pending)
  return waitForPromiseWithSignal(pending, options.signal)
}

export async function assembleOrcadArtifact(args: {
  templateDir: string
  cacheRoot: string
  target: NodeRuntimeTarget
  manifest?: OrcadTemplateManifest
  includeDeploymentTemplate?: boolean
}): Promise<string> {
  const manifest = args.manifest ?? (await readOrcadTemplateManifest(args.templateDir))
  await verifyOrcadTemplateTarget(args.templateDir, args.target, manifest)
  const sources = artifactSources(args.templateDir, args.target, manifest)
  const { fullVersion, sourceHashes } = await computeArtifactIdentity(sources)
  const controlResources = args.includeDeploymentTemplate
    ? await collectOrcadControlHostResources(args.templateDir, manifest, args.target)
    : null
  const slotName = fullVersion + (controlResources?.suffix ?? '')
  const verify = async (path: string): Promise<boolean> => {
    if (!(await isCompleteArtifact(path, fullVersion, sources, sourceHashes))) {
      return false
    }
    try {
      await controlResources?.verify(path)
      return true
    } catch {
      return false
    }
  }
  const targetRoot = join(args.cacheRoot, args.target)
  const cached = await findOrcadCachePath(
    (attempt) => join(targetRoot, `${slotName}${attempt ? `.repair-${attempt}` : ''}`),
    verify
  )
  const targetDir = cached.path
  materializedVersions.add(fullVersion)
  if (cached.verified) {
    // Retention evicts by recency, so a reused slot counts as recently used.
    const now = new Date()
    await utimes(targetDir, now, now).catch(() => undefined)
    return targetDir
  }
  await mkdir(targetRoot, { recursive: true })
  const stagingDir = join(targetRoot, `.staging-${process.pid}-${randomUUID()}`)
  try {
    for (const source of [...sources, ...(controlResources?.sources ?? [])]) {
      const destination = join(stagingDir, source.filename)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source.path, destination)
      if (source.executable && !args.target.startsWith('win32-')) {
        await chmod(destination, 0o755)
      }
    }
    await writeFile(join(stagingDir, ORCAD_VERSION_FILENAME), `${fullVersion}\n`, { mode: 0o600 })
    if (!(await verify(stagingDir))) {
      throw new Error('Orcad artifact sources changed while copying')
    }
    try {
      await rename(stagingDir, targetDir)
    } catch (error) {
      if (!(await verify(targetDir))) {
        throw new Error(`Orcad artifact cache entry is unavailable or corrupted: ${targetDir}`, {
          cause: error
        })
      }
    }
    return targetDir
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}

function isExecutableArtifact(filename: string): boolean {
  return /(?:^|\/)(?:rg|spawn-helper)$/.test(filename)
}

function artifactSources(
  templateDir: string,
  target: NodeRuntimeTarget,
  manifest: OrcadTemplateManifest
): { filename: string; path: string; executable?: boolean }[] {
  const targetDir = join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
  const targetManifest = manifest.targets[target]
  if (!targetManifest) {
    throw new OrcadHostUnsupportedError(`Packaged orcad template does not support ${target}`)
  }
  const targetFiles = new Set(orcadTemplateTargetFilenames(target))
  const required = orcadArtifactFilenames(target).map((filename) => ({
    filename,
    path: join(targetFiles.has(filename) ? targetDir : templateDir, ...filename.split('/')),
    executable: isExecutableArtifact(filename)
  }))
  if (!targetManifest.browserName) {
    return required
  }
  return [
    ...required,
    {
      filename: targetManifest.browserName,
      path: join(targetDir, targetManifest.browserName),
      executable: true
    }
  ]
}

async function computeArtifactIdentity(
  sources: { filename: string; path: string }[]
): Promise<{ fullVersion: string; sourceHashes: Map<string, string> }> {
  const hash = createHash('sha256')
  const sourceHashes = new Map<string, string>()
  for (const source of sources) {
    const sourceHash = createHash('sha256')
    for await (const chunk of createReadStream(source.path)) {
      hash.update(chunk)
      sourceHash.update(chunk)
    }
    sourceHashes.set(source.filename, sourceHash.digest('hex'))
  }
  return {
    fullVersion: `${ORCAD_VERSION}+${hash.digest('hex').slice(0, 12)}`,
    sourceHashes
  }
}

async function isCompleteArtifact(
  dir: string,
  fullVersion: string,
  sources: { filename: string }[],
  sourceHashes: Map<string, string>
): Promise<boolean> {
  try {
    if ((await readFile(join(dir, ORCAD_VERSION_FILENAME), 'utf8')).trim() !== fullVersion) {
      return false
    }
    for (const source of sources) {
      if ((await fileSha256(join(dir, source.filename))) !== sourceHashes.get(source.filename)) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

export function getOrcadTemplateCandidates(): string[] {
  const candidates: string[] = []
  if (process.env.ORCA_ORCAD_TEMPLATE_PATH) {
    candidates.push(process.env.ORCA_ORCAD_TEMPLATE_PATH)
  }
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'orcad-template'))
  }
  const appPath = getAppEnvironment().getAppPath()
  candidates.push(
    join(appPath, 'out', 'orcad-template'),
    join(appPath, 'resources', 'orcad-template')
  )
  return [...new Set(candidates)]
}

/** Whether this build carries an orcad template at all; dev builds usually don't. */
export function hasOrcadTemplate(): boolean {
  return getOrcadTemplateCandidates().some((candidate) => existsSync(candidate))
}

function resolveOrcadTemplateDir(): string {
  const found = getOrcadTemplateCandidates().find((candidate) => existsSync(candidate))
  if (!found) {
    throw new OrcadArtifactsUnavailableError('The packaged orcad deployment template is missing')
  }
  return found
}

export function resetOrcadArtifactMaterializationsForTests(): void {
  materializations.clear()
}

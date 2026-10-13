import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  z,
  pluginManifestV2Schema,
  qualifiedPluginKey,
  pluginCatalogTypes,
  createPluginLocaleKit,
  parsePluginLocaleEnvelope,
  readPluginSyntaxContent,
  readContainedPluginArtifactText,
  resolveContainedPluginArtifact,
  hashPluginTree,
  PLUGIN_VIEWER_ENTRY_BYTES,
  PLUGIN_MANIFEST_MAX_BYTES
} from '../dist/runtime.mjs'

const MAX_JSON_BYTES = 5 * 1024 * 1024
const kitSchema = z.strictObject({
  formatVersion: z.literal(1),
  sourceRevision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  entries: z
    .record(
      z.string().max(2048),
      // Preserve the host kit's field order for revision hashes.
      z.strictObject({
        value: z.string().max(MAX_JSON_BYTES),
        sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/)
      })
    )
    .refine((entries) => Object.keys(entries).length <= 20_000)
})

export async function readJson(path) {
  const { readNodeFileHandleWithinLimit } = await import('../dist/runtime.mjs')
  const { open } = await import('node:fs/promises')
  const { constants } = await import('node:fs')
  const handle = await open(
    path,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK)
  )
  try {
    const { buffer } = await readNodeFileHandleWithinLimit(handle, MAX_JSON_BYTES, {
      regularFileOnly: true
    })
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
  } finally {
    await handle.close()
  }
}

export function validateLocaleKit(raw) {
  const kit = kitSchema.parse(raw)
  const regenerated = createPluginLocaleKit(
    Object.fromEntries(Object.entries(kit.entries).map(([key, entry]) => [key, entry.value]))
  )
  const revision = `sha256:${createHash('sha256').update(JSON.stringify(kit.entries)).digest('hex')}`
  if (
    kit.sourceRevision !== revision ||
    Object.keys(kit.entries).some(
      (key) => kit.entries[key].sourceHash !== regenerated.entries[key]?.sourceHash
    )
  ) {
    throw new Error('translation kit hashes do not match its source text')
  }
  return kit
}

export async function loadLocaleKit(path) {
  return validateLocaleKit(
    await readJson(path ?? fileURLToPath(new URL('../locale-kit.json', import.meta.url)))
  )
}

export async function validatePackage(root, options = {}) {
  const manifest = pluginManifestV2Schema.parse(
    JSON.parse(
      await readContainedPluginArtifactText(root, 'orca-plugin.json', PLUGIN_MANIFEST_MAX_BYTES)
    )
  )
  const types = pluginCatalogTypes(manifest)
  if (
    !types.length ||
    types.some(
      (type) => !['interface-language', 'coding-language', 'file-viewer'].includes(type)
    ) ||
    manifest.capabilities.length
  ) {
    throw new Error(
      'This toolkit validates locale, syntax and host-ui viewer packages without host capabilities. Other plugin families require their host-specific validator.'
    )
  }
  const locales = []
  const kit = manifest.contributes.languagePacks.length
    ? await loadLocaleKit(options.kit)
    : undefined
  for (const contribution of manifest.contributes.languagePacks) {
    const parsed = parsePluginLocaleEnvelope(
      await readContainedPluginArtifactText(root, contribution.path, MAX_JSON_BYTES),
      contribution.locale,
      kit
    )
    locales.push({ locale: contribution.locale, ...parsed.coverage })
  }
  await readPluginSyntaxContent(manifest, (path, limit) =>
    readContainedPluginArtifactText(root, path, limit)
  )
  for (const viewer of manifest.contributes.fileViewers) {
    if (
      !(await readContainedPluginArtifactText(root, viewer.entry, PLUGIN_VIEWER_ENTRY_BYTES)).trim()
    ) {
      throw new Error(`viewer entry is empty: ${viewer.entry}`)
    }
  }
  if (manifest.icon) {
    await resolveContainedPluginArtifact(root, manifest.icon, 2 * 1024 * 1024)
  }
  const license = await readContainedPluginArtifactText(root, 'LICENSE', 256 * 1024)
  if (!license.trim()) {
    throw new Error('LICENSE must contain the package license')
  }
  const result = { manifest, id: qualifiedPluginKey(manifest), types, locales }
  if (!options.release) {
    return result
  }
  const tree = await hashPluginTree(root)
  if (!tree.ok) {
    throw new Error(tree.error)
  }
  return {
    ...result,
    contentHash: tree.hash,
    fileCount: tree.fileCount,
    totalBytes: tree.totalBytes
  }
}

export async function inspectPackage(root, options) {
  const result = await validatePackage(root, { ...options, release: true })
  const { manifest, ...inspection } = result
  return {
    ...inspection,
    name: manifest.name,
    version: manifest.version,
    execution: manifest.execution,
    minimumOrca: manifest.engines.orca.slice(2),
    needsExecutableApproval: manifest.execution !== 'data',
    note: 'Validation inspects data and prebuilt entries. It does not execute or certify plugin code.'
  }
}

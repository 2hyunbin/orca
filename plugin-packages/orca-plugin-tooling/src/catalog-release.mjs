import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginCatalogSchema, pluginCatalogEntrySchema } from '../dist/runtime.mjs'
import { git, packRelease } from './git-release.mjs'
import { readJson } from './package-validation.mjs'

export async function exportCatalogRelease(root, options) {
  if (!options.source || !options.ref || !options.license) {
    throw new Error('catalog export requires --source, --ref and --license')
  }
  if (!/^v?[0-9][0-9A-Za-z.+-]{0,127}$/.test(options.ref)) {
    throw new Error('Release ref must be a version tag')
  }
  const temporary = await mkdtemp(join(tmpdir(), 'orca-plugin-release-'))
  try {
    const packed = await packRelease(root, join(temporary, 'release'), options)
    const tagged = (
      await git(root, ['rev-parse', '--verify', `refs/tags/${options.ref}^{commit}`])
    ).trim()
    if (tagged !== packed.commit) {
      throw new Error('Release tag must point to the packaged commit')
    }
    if (options.ref.replace(/^v/, '') !== packed.manifest.version) {
      throw new Error('Release tag must match manifest semver')
    }
    return pluginCatalogEntrySchema.parse({
      id: packed.id,
      name: packed.manifest.name,
      description: packed.manifest.description,
      categories: packed.types,
      source: { kind: 'git', url: options.source, ref: options.ref },
      release: {
        version: packed.manifest.version,
        commit: packed.commit,
        contentHash: packed.contentHash,
        execution: packed.manifest.execution,
        minimumOrca: packed.manifest.engines.orca.slice(2),
        types: packed.types,
        license: options.license
      }
    })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export async function diffCatalogFiles(previousPath, currentPath) {
  const previous = pluginCatalogSchema.parse(await readJson(previousPath))
  const current = pluginCatalogSchema.parse(await readJson(currentPath))
  const prior = new Map(previous.plugins.map((entry) => [entry.id, entry]))
  const next = new Map(current.plugins.map((entry) => [entry.id, entry]))
  return {
    ownerChanged: previous.owner !== current.owner,
    added: [...next.keys()].filter((id) => !prior.has(id)).sort(),
    removed: [...prior.keys()].filter((id) => !next.has(id)).sort(),
    changed: [...next.keys()].sort().flatMap((id) => {
      const before = prior.get(id),
        after = next.get(id)
      if (!before || JSON.stringify(before) === JSON.stringify(after)) {
        return []
      }
      return [
        {
          id,
          previousVersion: before.release.version,
          version: after.release.version,
          sourceChanged: before.source.url !== after.source.url,
          executionChanged: before.release.execution !== after.release.execution,
          typesChanged:
            JSON.stringify([...before.release.types].sort()) !==
            JSON.stringify([...after.release.types].sort()),
          bytesChanged: before.release.contentHash !== after.release.contentHash,
          note: 'This metadata diff does not approve or classify changed instructions or executable code.'
        }
      ]
    })
  }
}

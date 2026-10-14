import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { pluginMarketplaceSchema } from '../../../src/shared/plugins/plugin-marketplace'
import type { createPluginCatalogFixture } from './plugin-catalog-fixture'

export type PluginPublicationBoundary = 'before-pointer' | 'before-index' | 'after-index'

export async function viewerFixtureReleaseHash(
  fixture: Awaited<ReturnType<typeof createPluginCatalogFixture>>
): Promise<string> {
  const catalog = pluginMarketplaceSchema.parse(
    JSON.parse(
      await readFile(
        join(fixture.root, 'repositories', 'orca-plugins.git', 'orca-marketplace.json'),
        'utf8'
      )
    )
  )
  if (!('formatVersion' in catalog) || catalog.formatVersion !== 2) {
    throw new Error('Publication fixture needs a pinned catalog')
  }
  const release = catalog.plugins.find((plugin) => plugin.id === 'stablyai.orca-viewer-sample')
  if (!release) {
    throw new Error('Publication fixture has no viewer release')
  }
  return release.release.contentHash
}

export async function pausePluginPublication(input: {
  app: ElectronApplication
  pluginDirectory: string
  lockfile: string
  contentHash: string
  marker: string
  boundary: PluginPublicationBoundary
}): Promise<void> {
  await input.app.evaluate(
    (_electron, input) => {
      const fs = process.getBuiltinModule('fs')
      const modules = process.getBuiltinModule('module')
      const rename = fs.promises.rename
      const pointer = process.getBuiltinModule('path').join(input.pluginDirectory, 'current')
      let paused = false
      fs.promises.rename = async (source, destination) => {
        const expectedTarget = input.boundary === 'before-pointer' ? pointer : input.lockfile
        let matches = false
        if (!paused && destination === expectedTarget) {
          try {
            matches =
              fs
                .readFileSync(input.boundary === 'before-pointer' ? source : pointer, 'utf8')
                .trim() === input.contentHash
          } catch {
            matches = false
          }
        }
        if (!matches) {
          return rename(source, destination)
        }
        paused = true
        if (input.boundary === 'after-index') {
          await rename(source, destination)
        }
        fs.writeFileSync(
          input.marker,
          JSON.stringify({ pid: process.pid, boundary: input.boundary })
        )
        // Keep the real publication pending until the test force-quits this owned app.
        await new Promise<void>(() => {})
      }
      modules.syncBuiltinESMExports()
    },
    {
      pluginDirectory: input.pluginDirectory,
      lockfile: input.lockfile,
      contentHash: input.contentHash,
      marker: input.marker,
      boundary: input.boundary
    }
  )
}

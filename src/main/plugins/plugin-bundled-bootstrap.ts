import { readBundledPluginIndex, resolveBundlePath } from './plugin-bundled-index'
export { BUNDLED_PLUGIN_INDEX_FILENAME } from './plugin-bundled-index'
import { join } from 'node:path'
import { getUserPluginsDir } from './plugin-discovery'
import { installBundledPlugin, readPluginLockfile } from './plugin-install'
import { inspectPluginInstallTree } from './plugin-install-staging'
import { readPluginCurrentPointer } from './plugin-current-pointer'
import { hashPluginTree } from './plugin-content-hash'

export type PluginBundledBootstrapResult = {
  installed: string[]
  unchanged: string[]
  errors: { pluginKey: string; error: string }[]
}

export function resolveBundledPluginRoot(options: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, 'plugins', 'launch')
    : join(options.appPath, 'resources', 'plugins', 'launch')
}

async function bundledInstallIsIntact(
  pluginsDir: string,
  pluginKey: string,
  contentHash: string
): Promise<boolean> {
  const pluginDir = join(pluginsDir, pluginKey)
  if ((await readPluginCurrentPointer(pluginDir).catch(() => null)) !== contentHash) {
    return false
  }
  const hashed = await hashPluginTree(join(pluginDir, contentHash))
  return hashed.ok && hashed.hash === contentHash
}

export async function bootstrapBundledPlugins(options: {
  root: string
  userDataPath: string
  hostVersion: string
  blockedPluginReason?: (pluginKey: string) => string | null
}): Promise<PluginBundledBootstrapResult> {
  const index = await readBundledPluginIndex(options.root)
  const pluginsDir = getUserPluginsDir(options.userDataPath)
  const lock = await readPluginLockfile(pluginsDir)
  const result: PluginBundledBootstrapResult = { installed: [], unchanged: [], errors: [] }
  for (const entry of index.plugins) {
    if (entry.activation === 'bundled-data') {
      continue
    }
    const locked = lock.plugins[entry.pluginKey]
    if (
      locked?.source.kind === 'bundled' &&
      locked.source.bundleId === entry.pluginKey &&
      locked.contentHash === entry.contentHash &&
      (await bundledInstallIsIntact(pluginsDir, entry.pluginKey, entry.contentHash))
    ) {
      result.unchanged.push(entry.pluginKey)
      continue
    }
    try {
      const sourcePath = await resolveBundlePath(options.root, entry.path)
      const inspection = await inspectPluginInstallTree({
        rootDir: sourcePath,
        hostVersion: options.hostVersion,
        expectedPluginKey: entry.pluginKey
      })
      if (!inspection.ok) {
        throw new Error(inspection.error)
      }
      if (inspection.contentHash !== entry.contentHash) {
        throw new Error('bundled plugin content does not match its release index')
      }
      const installed = await installBundledPlugin({
        pluginsDir,
        sourcePath,
        hostVersion: options.hostVersion,
        expectedPluginKey: entry.pluginKey,
        blockedPluginReason: options.blockedPluginReason
      })
      if (!installed.ok) {
        throw new Error(installed.error)
      }
      result.installed.push(entry.pluginKey)
    } catch (error) {
      result.errors.push({
        pluginKey: entry.pluginKey,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return result
}

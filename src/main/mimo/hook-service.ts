import { getAppEnvironment } from '../../shared/app-environment'
import { join } from 'node:path'
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { getOpenCodeFamilyPluginSource } from '../opencode/hook-service'
import { sourceOverlayDirName } from '../opencode/overlay-dir-names'
import { isSafeDescendCandidate, mirrorEntry, safeRemoveTree } from '../pty/overlay-mirror'

const ORCA_MIMOCODE_PLUGIN_FILE = 'orca-mimocode-status.js'
const MIMOCODE_HOOKS_DIR = 'mimocode-hooks'
const PLUGIN_ONLY_CONFIG_DIR = 'config'
const SOURCE_CONFIG_OVERLAYS_DIR = 'config-overlays'

function isDirectoryFollowingLinks(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function mirrorConfigDir(sourceConfigDir: string, targetConfigDir: string): void {
  for (const entry of readdirSync(sourceConfigDir, { withFileTypes: true })) {
    const sourcePath = join(sourceConfigDir, entry.name)
    // A linked plugins dir must not be linked through, or Orca's plugin lands in the user's folder.
    if (entry.name === 'plugins' && isDirectoryFollowingLinks(sourcePath)) {
      const overlayPlugins = join(targetConfigDir, 'plugins')
      mkdirSync(overlayPlugins, { recursive: true })
      for (const pluginName of readdirSync(sourcePath)) {
        if (pluginName !== ORCA_MIMOCODE_PLUGIN_FILE) {
          mirrorEntry(join(sourcePath, pluginName), join(overlayPlugins, pluginName))
        }
      }
      continue
    }
    mirrorEntry(sourcePath, join(targetConfigDir, entry.name))
  }
}

function ensureRealDirectory(path: string): boolean {
  mkdirSync(path, { recursive: true })
  return isSafeDescendCandidate(lstatSync(path))
}

export class MimoCodeHookService {
  clearPty(_ptyId: string): void {}

  /** MIMOCODE_CONFIG_DIR adds a config layer; MIMOCODE_HOME would also move auth and session data. */
  buildPtyEnv(_ptyId: string, existingConfigDir?: string): { MIMOCODE_CONFIG_DIR?: string } {
    const fallback = { MIMOCODE_CONFIG_DIR: existingConfigDir }
    const root = join(getAppEnvironment().getPath('userData'), MIMOCODE_HOOKS_DIR)
    const overlay = existingConfigDir
      ? join(root, SOURCE_CONFIG_OVERLAYS_DIR, sourceOverlayDirName(existingConfigDir))
      : join(root, PLUGIN_ONLY_CONFIG_DIR)
    try {
      if (!ensureRealDirectory(root) || !ensureRealDirectory(overlay)) {
        return fallback
      }
      if (existingConfigDir && existsSync(existingConfigDir)) {
        safeRemoveTree(overlay)
        mkdirSync(overlay, { recursive: true })
        mirrorConfigDir(existingConfigDir, overlay)
      }
      const pluginsDir = join(overlay, 'plugins')
      if (!ensureRealDirectory(pluginsDir)) {
        return fallback
      }
      writeFileSync(
        join(pluginsDir, ORCA_MIMOCODE_PLUGIN_FILE),
        getOpenCodeFamilyPluginSource('/hook/mimo-code', { emitSessionStart: false })
      )
    } catch {
      return fallback
    }
    return { MIMOCODE_CONFIG_DIR: overlay }
  }
}

export const mimoCodeHookService = new MimoCodeHookService()

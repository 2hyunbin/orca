import {
  PLUGIN_WORKER_ENTRY_MAX_BYTES,
  readContainedPluginArtifactText,
  resolvePluginArtifactFromRealRoot
} from './plugin-artifact-file-reader'
export {
  PLUGIN_WORKER_ENTRY_MAX_BYTES,
  readContainedPluginArtifactText,
  resolveContainedPluginArtifact
} from './plugin-artifact-file-reader'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { PluginManifest } from '../../shared/plugins/plugin-manifest'
import { parsePluginVmRecipeArtifact } from '../../shared/plugins/plugin-vm-recipe-artifact'

export type PluginArtifactValidationResult = { ok: true } | { ok: false; error: string }

export const PLUGIN_PANEL_ENTRY_MAX_BYTES = 10 * 1024 * 1024
const PLUGIN_ICON_MAX_BYTES = 2 * 1024 * 1024
export const PLUGIN_LANGUAGE_PACK_MAX_BYTES = 5 * 1024 * 1024
export const PLUGIN_VM_RECIPE_MAX_BYTES = 256 * 1024
const PLUGIN_AGENT_PROFILE_MAX_BYTES = 1024 * 1024

type DeclaredArtifact =
  | { label: string; path: string; kind: 'file'; maxBytes: number }
  | { label: string; path: string; kind: 'directory' }

function declaredArtifactPaths(manifest: PluginManifest): DeclaredArtifact[] {
  return [
    ...(manifest.icon
      ? [
          {
            label: 'icon',
            path: manifest.icon,
            kind: 'file' as const,
            maxBytes: PLUGIN_ICON_MAX_BYTES
          }
        ]
      : []),
    ...(manifest.main
      ? [
          {
            label: 'worker entry',
            path: manifest.main,
            kind: 'file' as const,
            maxBytes: PLUGIN_WORKER_ENTRY_MAX_BYTES
          }
        ]
      : []),
    ...manifest.contributes.panels.map((panel) => ({
      label: `panel "${panel.id}" entry`,
      path: panel.entry,
      kind: 'file' as const,
      maxBytes: PLUGIN_PANEL_ENTRY_MAX_BYTES
    })),
    ...manifest.contributes.languagePacks.map((languagePack) => ({
      label: `language pack "${languagePack.locale}"`,
      path: languagePack.path,
      kind: 'file' as const,
      maxBytes: PLUGIN_LANGUAGE_PACK_MAX_BYTES
    })),
    ...manifest.contributes.vmRecipes.map((recipe) => ({
      label: 'VM recipe',
      path: recipe.path,
      kind: 'file' as const,
      maxBytes: PLUGIN_VM_RECIPE_MAX_BYTES
    })),
    ...manifest.contributes.agents.map((agent) => ({
      label: 'agent profile',
      path: agent.path,
      kind: 'file' as const,
      maxBytes: PLUGIN_AGENT_PROFILE_MAX_BYTES
    }))
  ]
}

export async function validateDeclaredPluginArtifacts(
  rootDir: string,
  manifest: PluginManifest
): Promise<PluginArtifactValidationResult> {
  const artifacts = declaredArtifactPaths(manifest)
  if (artifacts.length === 0) {
    return { ok: true }
  }
  const seen = new Set<string>()
  let rootReal: string
  try {
    rootReal = await realpath(resolve(rootDir))
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  for (const artifact of artifacts) {
    if (seen.has(artifact.path)) {
      continue
    }
    seen.add(artifact.path)
    try {
      await resolvePluginArtifactFromRealRoot(
        rootDir,
        rootReal,
        artifact.path,
        artifact.kind,
        artifact.kind === 'file' ? artifact.maxBytes : undefined
      )
    } catch (error) {
      return {
        ok: false,
        error: `${artifact.label} ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  return { ok: true }
}

/** Parses declared VM recipe artifacts at the immutable install boundary. */
export async function validatePluginInstallContent(
  rootDir: string,
  manifest: PluginManifest
): Promise<PluginArtifactValidationResult> {
  const vmRecipeIds = new Set<string>()
  for (const contribution of manifest.contributes.vmRecipes) {
    try {
      const recipe = parsePluginVmRecipeArtifact(
        await readContainedPluginArtifactText(
          rootDir,
          contribution.path,
          PLUGIN_VM_RECIPE_MAX_BYTES
        )
      )
      if (vmRecipeIds.has(recipe.id)) {
        throw new Error(`duplicate VM recipe id "${recipe.id}"`)
      }
      vmRecipeIds.add(recipe.id)
    } catch (error) {
      return {
        ok: false,
        error: `VM recipe ${contribution.path}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  return { ok: true }
}

import { parsePluginLocaleContent } from './plugin-locale-content'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { PluginManifest } from '../../shared/plugins/plugin-manifest'
import {
  parsePluginIconThemeArtifact,
  sanitizePluginIconSvg
} from '../../shared/plugins/plugin-icon-theme-artifact'
import { parsePluginVmRecipeArtifact } from '../../shared/plugins/plugin-vm-recipe-artifact'
import {
  PLUGIN_SYNTAX_CONFIGURATION_MAX_BYTES,
  PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES
} from '../../shared/plugins/plugin-syntax-contributions'
import { PLUGIN_VIEWER_ENTRY_BYTES } from '../../shared/plugins/plugin-viewer-contributions'
import { PLUGIN_ENVIRONMENT_RECIPE_BYTES } from '../../shared/plugins/plugin-environment-recipe-artifact'
import { validatePluginEnvironmentRecipeArtifacts } from './plugin-environment-recipe-validation'
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

export type PluginArtifactValidationResult = { ok: true } | { ok: false; error: string }

export const PLUGIN_PANEL_ENTRY_MAX_BYTES = 10 * 1024 * 1024
const PLUGIN_ICON_MAX_BYTES = 2 * 1024 * 1024
export const PLUGIN_THEME_MAX_BYTES = 256 * 1024
export const PLUGIN_ICON_THEME_MAX_BYTES = 512 * 1024
export const PLUGIN_ICON_SVG_MAX_BYTES = 64 * 1024
export const PLUGIN_ICON_TOTAL_MAX_BYTES = 8 * 1024 * 1024
export const PLUGIN_TERMINAL_THEME_MAX_BYTES = 256 * 1024
export const PLUGIN_LANGUAGE_PACK_MAX_BYTES = 5 * 1024 * 1024
export const PLUGIN_VM_RECIPE_MAX_BYTES = 256 * 1024
const PLUGIN_AGENT_PROFILE_MAX_BYTES = 1024 * 1024

type DeclaredArtifact =
  | { label: string; path: string; kind: 'file'; maxBytes: number }
  | { label: string; path: string; kind: 'directory' }

function declaredArtifactPaths(manifest: PluginManifest): DeclaredArtifact[] {
  return [
    ...(manifest.manifestVersion === 2
      ? [
          ...manifest.contributes.environmentRecipes.map((recipe) => ({
            label: 'environment recipe',
            path: recipe.path,
            kind: 'file' as const,
            maxBytes: PLUGIN_ENVIRONMENT_RECIPE_BYTES
          })),
          ...manifest.contributes.languages.flatMap((language) =>
            language.configuration
              ? [
                  {
                    label: `syntax configuration "${language.id}"`,
                    path: language.configuration,
                    kind: 'file' as const,
                    maxBytes: PLUGIN_SYNTAX_CONFIGURATION_MAX_BYTES
                  }
                ]
              : []
          ),
          ...manifest.contributes.grammars.map((grammar) => ({
            label: `grammar "${grammar.language}"`,
            path: grammar.path,
            kind: 'file' as const,
            maxBytes: PLUGIN_SYNTAX_GRAMMAR_MAX_BYTES
          })),
          ...manifest.contributes.fileViewers.map((viewer) => ({
            label: `viewer "${viewer.id}" entry`,
            path: viewer.entry,
            kind: 'file' as const,
            maxBytes: PLUGIN_VIEWER_ENTRY_BYTES
          }))
        ]
      : []),
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
    ...manifest.contributes.themes.map((theme) => ({
      label: `theme "${theme.id}"`,
      path: theme.path,
      kind: 'file' as const,
      maxBytes: PLUGIN_THEME_MAX_BYTES
    })),
    ...manifest.contributes.iconThemes.map((theme) => ({
      label: `icon theme "${theme.id}"`,
      path: theme.path,
      kind: 'file' as const,
      maxBytes: PLUGIN_ICON_THEME_MAX_BYTES
    })),
    ...manifest.contributes.terminalThemes.map((theme) => ({
      label: `terminal theme "${theme.id}"`,
      path: theme.path,
      kind: 'file' as const,
      maxBytes: PLUGIN_TERMINAL_THEME_MAX_BYTES
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

/** Presence and containment checks are bounded by the manifest's declared artifacts. */
export async function validateDeclaredPluginArtifacts(
  rootDir: string,
  manifest: PluginManifest
): Promise<PluginArtifactValidationResult> {
  const artifacts = declaredArtifactPaths(manifest)
  const environmentError = await validatePluginEnvironmentRecipeArtifacts(rootDir, manifest)
  if (environmentError) {
    return { ok: false, error: environmentError }
  }
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

/** Parses and sanitizes icon-theme references at the immutable install boundary. */
export async function validatePluginInstallContent(
  rootDir: string,
  manifest: PluginManifest
): Promise<PluginArtifactValidationResult> {
  if (manifest.manifestVersion === 2) {
    for (const viewer of manifest.contributes.fileViewers) {
      try {
        const source = await readContainedPluginArtifactText(
          rootDir,
          viewer.entry,
          PLUGIN_VIEWER_ENTRY_BYTES
        )
        if (!source.trim()) {
          throw new Error('viewer entry is empty')
        }
      } catch (error) {
        return {
          ok: false,
          error: `viewer "${viewer.id}": ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }
    try {
      const { readPluginSyntaxContent } = await import('./plugin-syntax-content')
      await readPluginSyntaxContent(manifest, (path, limit) =>
        readContainedPluginArtifactText(rootDir, path, limit)
      )
    } catch (error) {
      return {
        ok: false,
        error: `syntax pack: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    for (const contribution of manifest.contributes.languagePacks) {
      try {
        await parsePluginLocaleContent(
          await readContainedPluginArtifactText(
            rootDir,
            contribution.path,
            PLUGIN_LANGUAGE_PACK_MAX_BYTES
          ),
          contribution.locale,
          2
        )
      } catch (error) {
        return {
          ok: false,
          error: `language pack "${contribution.locale}": ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }
  }
  let iconBytes = 0
  for (const contribution of manifest.contributes.iconThemes) {
    try {
      const artifact = parsePluginIconThemeArtifact(
        await readContainedPluginArtifactText(
          rootDir,
          contribution.path,
          PLUGIN_ICON_THEME_MAX_BYTES
        )
      )
      const paths = new Set([
        ...Object.values(artifact.icons),
        ...Object.values(artifact.fileNames),
        ...Object.values(artifact.fileExtensions)
      ])
      for (const path of paths) {
        const svg = await readContainedPluginArtifactText(rootDir, path, PLUGIN_ICON_SVG_MAX_BYTES)
        iconBytes += Buffer.byteLength(svg, 'utf8')
        if (iconBytes > PLUGIN_ICON_TOTAL_MAX_BYTES) {
          throw new Error(`icon SVGs exceed ${PLUGIN_ICON_TOTAL_MAX_BYTES} bytes in total`)
        }
        sanitizePluginIconSvg(svg)
      }
    } catch (error) {
      return {
        ok: false,
        error: `icon theme "${contribution.id}": ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
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
